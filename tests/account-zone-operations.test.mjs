import test from 'node:test';
import assert from 'node:assert/strict';

const api = await import('../src/edgeone-client.mjs').catch(() => ({}));

function zoneClient(zones, extras = {}) {
  const calls = [];
  return {
    calls,
    client: {
      async DescribeZones(request) {
        calls.push(['DescribeZones', request]);
        const requested = request.Filters?.find((x) => x.Name === 'zone-id')?.Values?.[0];
        return { TotalCount: zones.length, Zones: requested ? zones.filter((z) => z.ZoneId === requested) : zones };
      },
      ...extras,
    },
  };
}

test('listAuthorizedZones returns all pages and only safe zone fields', async () => {
  assert.equal(typeof api.listAuthorizedZones, 'function', 'zone-list implementation is missing');
  const firstPage = Array.from({ length: 100 }, (_, i) => ({
    ZoneId: `zone-${i}`,
    ZoneName: `site-${i}.example`,
    Status: 'active',
    Secret: 'must-not-return',
  }));
  const calls = [];
  const client = { async DescribeZones(request) {
    calls.push(request);
    return request.Offset === 0
      ? { TotalCount: 101, Zones: firstPage }
      : { TotalCount: 101, Zones: [{ ZoneId: 'zone-last', ZoneName: 'last.example', Status: 'active' }] };
  } };

  const zones = await api.listAuthorizedZones(client);
  assert.deepEqual(calls.map(({ Offset, Limit }) => ({ Offset, Limit })), [
    { Offset: 0, Limit: 100 },
    { Offset: 100, Limit: 100 },
  ]);
  assert.equal(zones.length, 101);
  assert.equal(zones[0].Secret, undefined);
  assert.deepEqual(zones.at(-1), { ZoneId: 'zone-last', ZoneName: 'last.example', Status: 'active' });
});

test('resolveAuthorizedZone only accepts a ZoneId returned by DescribeZones', async () => {
  assert.equal(typeof api.resolveAuthorizedZone, 'function', 'zone resolver implementation is missing');
  const { client, calls } = zoneClient([
    { ZoneId: 'zone-one', ZoneName: 'one.example', Status: 'active' },
    { ZoneId: 'zone-two', ZoneName: 'two.example', Status: 'active' },
  ]);
  const zone = await api.resolveAuthorizedZone(client, 'zone-two');
  assert.deepEqual(zone, { ZoneId: 'zone-two', ZoneName: 'two.example', Status: 'active' });
  assert.deepEqual(calls[0][1].Filters, [{ Name: 'zone-id', Values: ['zone-two'], Fuzzy: false }]);
  await assert.rejects(api.resolveAuthorizedZone(client, 'zone-unknown'), /not available/i);
  await assert.rejects(api.resolveAuthorizedZone(client, '*'), /valid/i);
});

test('createL7Rule always supplies a verified ZoneId and rejects caller ZoneId fields', async () => {
  assert.equal(typeof api.createL7Rule, 'function', 'rule-create implementation is missing');
  let request;
  const { client } = zoneClient([{ ZoneId: 'zone-one', ZoneName: 'one.example', Status: 'active' }], {
    async CreateL7AccRules(value) { request = value; return { RuleIds: ['rule-new'] }; },
  });
  const result = await api.createL7Rule(client, 'zone-one', { RuleName: 'header-rule' });
  assert.deepEqual(request, { ZoneId: 'zone-one', Rules: [{ RuleName: 'header-rule' }] });
  assert.deepEqual(result, { ZoneId: 'zone-one', ZoneName: 'one.example', RuleIds: ['rule-new'] });

  const badClient = zoneClient([{ ZoneId: 'zone-one', ZoneName: 'one.example', Status: 'active' }], {
    async CreateL7AccRules() { throw new Error('must not call'); },
  }).client;
  await assert.rejects(api.createL7Rule(badClient, 'zone-one', { ZoneId: 'zone-two' }), /ZoneId/i);
});

test('modify and delete rules are constrained to one verified ZoneId', async () => {
  assert.equal(typeof api.modifyL7Rule, 'function', 'rule-modify implementation is missing');
  assert.equal(typeof api.deleteL7Rules, 'function', 'rule-delete implementation is missing');
  const calls = [];
  const { client } = zoneClient([{ ZoneId: 'zone-one', ZoneName: 'one.example', Status: 'active' }], {
    async ModifyL7AccRule(request) { calls.push(['modify', request]); return {}; },
    async DeleteL7AccRules(request) { calls.push(['delete', request]); return {}; },
  });
  await api.modifyL7Rule(client, 'zone-one', 'rule-1', { RuleName: 'changed' });
  await api.deleteL7Rules(client, 'zone-one', ['rule-1', 'rule-2']);
  assert.deepEqual(calls, [
    ['modify', { ZoneId: 'zone-one', Rule: { RuleName: 'changed', RuleId: 'rule-1' } }],
    ['delete', { ZoneId: 'zone-one', RuleIds: ['rule-1', 'rule-2'] }],
  ]);
});

test('reorder requires the complete current rule set and cache purge stays inside the selected Zone', async () => {
  assert.equal(typeof api.reorderL7Rules, 'function', 'rule-order implementation is missing');
  assert.equal(typeof api.createCachePurge, 'function', 'cache-purge implementation is missing');
  const calls = [];
  const { client } = zoneClient([{ ZoneId: 'zone-one', ZoneName: 'one.example', Status: 'active' }], {
    async DescribeL7AccRules(request) { calls.push(['read-rules', request]); return { Rules: [{ RuleId: 'r1' }, { RuleId: 'r2' }] }; },
    async ModifyL7AccRulePriority(request) { calls.push(['order', request]); return {}; },
    async DescribeContentQuota(request) { calls.push(['quota', request]); return { PurgeQuota: [{ Type: 'purge_url', Batch: 500, Daily: 1000, DailyAvailable: 999 }] }; },
    async CreatePurgeTask(request) { calls.push(['purge', request]); return { JobId: 'job-1' }; },
  });
  await api.reorderL7Rules(client, 'zone-one', ['r2', 'r1']);
  const purge = await api.createCachePurge(client, 'zone-one', {
    type: 'purge_url',
    targets: ['https://www.one.example/app.css'],
  });
  assert.deepEqual(purge, { ZoneId: 'zone-one', ZoneName: 'one.example', JobId: 'job-1', FailedCount: 0 });
  assert.deepEqual(calls.find(([name]) => name === 'order')[1], { ZoneId: 'zone-one', RuleIds: ['r2', 'r1'] });
  assert.deepEqual(calls.find(([name]) => name === 'purge')[1], {
    ZoneId: 'zone-one', Type: 'purge_url', Targets: ['https://www.one.example/app.css'],
  });
  assert.deepEqual(calls.find(([name]) => name === 'quota')[1], { ZoneId: 'zone-one' });
  await assert.rejects(api.reorderL7Rules(client, 'zone-one', ['r1']), /every current/i);
  await assert.rejects(api.createCachePurge(client, 'zone-one', {
    type: 'purge_url', targets: ['https://other.example/app.css'],
  }), /outside the selected Zone/i);
});

test('getContentQuota returns only free-tier purge types and safe quota fields', async () => {
  assert.equal(typeof api.getContentQuota, 'function', 'content quota reader implementation is missing');
  const { client, calls } = zoneClient([{ ZoneId: 'zone-one', ZoneName: 'one.example', Status: 'active' }], {
    async DescribeContentQuota(request) {
      calls.push(['quota', request]);
      return {
        PurgeQuota: [
          { Type: 'purge_url', Batch: 500, Daily: 1000, DailyAvailable: 700, Secret: 'omit' },
          { Type: 'purge_prefix', Batch: 50, Daily: 50, DailyAvailable: 40 },
          { Type: 'purge_host', Batch: 50, Daily: 50, DailyAvailable: 30 },
          { Type: 'purge_all', Batch: 1, Daily: 10, DailyAvailable: 9 },
          { Type: 'purge_cache_tag', Batch: 50, Daily: 15000, DailyAvailable: 12000 },
        ],
        PrefetchQuota: [{ Type: 'prefetch_url', Batch: 0, Daily: 0, DailyAvailable: 0 }],
        RequestId: 'not-for-clients',
      };
    },
  });

  const result = await api.getContentQuota(client, 'zone-one');
  assert.deepEqual(calls.find(([name]) => name === 'quota')[1], { ZoneId: 'zone-one' });
  assert.deepEqual(result, {
    ZoneId: 'zone-one',
    ZoneName: 'one.example',
    PurgeQuota: [
      { Type: 'purge_url', Batch: 500, Daily: 1000, DailyAvailable: 700 },
      { Type: 'purge_prefix', Batch: 50, Daily: 50, DailyAvailable: 40 },
      { Type: 'purge_host', Batch: 50, Daily: 50, DailyAvailable: 30 },
      { Type: 'purge_all', Batch: 1, Daily: 10, DailyAvailable: 9 },
    ],
  });
});

test('free-tier cache purge rejects Cache-Tag and requests above returned quota', async () => {
  const calls = [];
  const { client } = zoneClient([{ ZoneId: 'zone-one', ZoneName: 'one.example', Status: 'active' }], {
    async DescribeContentQuota(request) {
      calls.push(['quota', request]);
      return { PurgeQuota: [{ Type: 'purge_url', Batch: 1, Daily: 2, DailyAvailable: 1 }] };
    },
    async CreatePurgeTask(request) { calls.push(['purge', request]); return { JobId: 'job-1' }; },
  });

  await assert.rejects(api.createCachePurge(client, 'zone-one', {
    type: 'purge_cache_tag', targets: ['static-v1'],
  }), /not supported in free-tier mode/i);
  await assert.rejects(api.createCachePurge(client, 'zone-one', {
    type: 'purge_url', targets: ['https://one.example/a.css', 'https://one.example/b.css'],
  }), /quota/i);
  assert.equal(calls.some(([name]) => name === 'purge'), false);
});

test('free-tier cache purge fails closed when the selected type has no returned quota', async () => {
  const calls = [];
  const { client } = zoneClient([{ ZoneId: 'zone-one', ZoneName: 'one.example', Status: 'active' }], {
    async DescribeContentQuota(request) { calls.push(['quota', request]); return { PurgeQuota: [] }; },
    async CreatePurgeTask(request) { calls.push(['purge', request]); return { JobId: 'job-1' }; },
  });

  await assert.rejects(api.createCachePurge(client, 'zone-one', {
    type: 'purge_url', targets: ['https://one.example/a.css'],
  }), /no free-tier quota/i);
  assert.equal(calls.some(([name]) => name === 'purge'), false);
});

test('listPurgeTasks filters by a Zone and job ID and returns safe task fields only', async () => {
  assert.equal(typeof api.listPurgeTasks, 'function', 'purge task reader implementation is missing');
  let request;
  const { client } = zoneClient([{ ZoneId: 'zone-one', ZoneName: 'one.example', Status: 'active' }], {
    async DescribePurgeTasks(value) {
      request = value;
      return { TotalCount: 1, Tasks: [{ JobId: 'job-1', Status: 'success', Target: 'https://one.example/x', FailMessage: 'sensitive detail' }] };
    },
  });
  const result = await api.listPurgeTasks(client, 'zone-one', { jobId: 'job-1' });
  assert.deepEqual(request, {
    ZoneId: 'zone-one',
    Offset: 0,
    Limit: 100,
    Filters: [{ Name: 'job-id', Values: ['job-1'] }],
  });
  assert.deepEqual(result, {
    ZoneId: 'zone-one',
    ZoneName: 'one.example',
    TotalCount: 1,
    Tasks: [{ JobId: 'job-1', Status: 'success' }],
  });
});
