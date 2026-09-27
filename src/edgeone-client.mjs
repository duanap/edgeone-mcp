import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tencentcloud = require('tencentcloud-sdk-nodejs-teo');
const TeoClient = tencentcloud.teo.v20220901.Client;
const SENSITIVE_KEY = /secret|token|password|authorization|cookie|credential|private.?key|(?:api|app|access).?key|^key$/i;
const SENSITIVE_HEADER = /secret|token|password|authorization|cookie|credential|key/i;
const SENSITIVE_VALUE_KEY = /^(?:value|values|headervalue|headervalues)$/i;
const ZONE_ID_PATTERN = /^zone-[A-Za-z0-9-]+$/;
const PURGE_TYPES = new Set(['purge_url', 'purge_prefix', 'purge_host', 'purge_all', 'purge_cache_tag']);
const ZONE_FIELDS = ['ZoneId', 'ZoneName', 'Status', 'ActiveStatus', 'Type', 'Paused', 'CnameStatus'];

function localError(code, message) {
  const error = new Error(message);
  error.name = 'EdgeOneInputError';
  error.code = code;
  return error;
}

export function createTeoClient(source = process.env) {
  const secretId = source.secretId ?? source.TENCENTCLOUD_SECRET_ID;
  const secretKey = source.secretKey ?? source.TENCENTCLOUD_SECRET_KEY;
  if (!secretId || !secretKey) {
    const error = new Error('Tencent Cloud credentials are not configured locally.');
    error.code = 'MissingCredentials';
    throw error;
  }

  return new TeoClient({
    credential: { secretId, secretKey },
    region: 'ap-guangzhou',
    profile: {
      signMethod: 'TC3-HMAC-SHA256',
      httpProfile: {
        endpoint: 'teo.tencentcloudapi.com',
        reqMethod: 'POST',
        reqTimeout: 30,
      },
    },
  });
}

function safeZone(zone) {
  return Object.fromEntries(ZONE_FIELDS
    .filter((key) => zone?.[key] !== undefined && zone?.[key] !== null)
    .map((key) => [key, zone[key]]));
}

function validateZoneId(zoneId) {
  if (typeof zoneId !== 'string' || !ZONE_ID_PATTERN.test(zoneId)) {
    throw localError('InvalidZoneId', 'ZoneId must be a valid EdgeOne zone identifier.');
  }
}

export async function listAuthorizedZones(client) {
  const zones = [];
  let offset = 0;
  let totalCount = Infinity;
  let complete = false;
  const limit = 100;

  for (let page = 0; page < 100 && offset < totalCount; page += 1) {
    const response = await client.DescribeZones({ Limit: limit, Offset: offset });
    const pageZones = Array.isArray(response?.Zones) ? response.Zones : [];
    totalCount = Number.isFinite(response?.TotalCount) ? response.TotalCount : totalCount;
    zones.push(...pageZones.filter((zone) => typeof zone?.ZoneId === 'string' && ZONE_ID_PATTERN.test(zone.ZoneId)).map(safeZone));
    if ((Number.isFinite(totalCount) && zones.length >= totalCount) || pageZones.length < limit) {
      complete = true;
      break;
    }
    offset += limit;
  }
  if (!complete && offset < totalCount) throw localError('TooManyZones', 'Zone list exceeds the supported pagination limit.');

  const unique = new Map(zones.map((zone) => [zone.ZoneId, zone]));
  return [...unique.values()];
}

export async function resolveAuthorizedZone(client, zoneId) {
  validateZoneId(zoneId);
  const response = await client.DescribeZones({
    Filters: [{ Name: 'zone-id', Values: [zoneId], Fuzzy: false }],
    Limit: 100,
    Offset: 0,
  });
  const zones = Array.isArray(response?.Zones) ? response.Zones : [];
  const matches = zones.filter((zone) => zone?.ZoneId === zoneId);
  if (matches.length !== 1) {
    throw localError('ZoneNotFound', `ZoneId ${zoneId} is not available to this CAM identity.`);
  }
  return safeZone(matches[0]);
}

function containsSensitiveHeaderName(record) {
  return Object.entries(record).some(([key, value]) =>
    /^(?:name|key|headername|headerkey)$/i.test(key)
      && typeof value === 'string'
      && SENSITIVE_HEADER.test(value));
}

function sanitize(value, sensitiveHeaderContext = false) {
  if (Array.isArray(value)) return value.map((item) => sanitize(item, sensitiveHeaderContext));
  if (value === null || typeof value !== 'object') return value;

  const redactHeaderValues = sensitiveHeaderContext || containsSensitiveHeaderName(value);
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (SENSITIVE_KEY.test(key) || (redactHeaderValues && SENSITIVE_VALUE_KEY.test(key))) {
      return [key, '[REDACTED]'];
    }
    return [key, sanitize(child, redactHeaderValues)];
  }));
}

export function sanitizeRuleData(rules) {
  return sanitize(Array.isArray(rules) ? rules : []);
}

function requireRule(rule, { allowRuleId }) {
  if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
    throw localError('InvalidRule', 'Rule must be a JSON object.');
  }
  const zoneKey = Object.keys(rule).find((key) => key.toLowerCase() === 'zoneid');
  if (zoneKey) throw localError('InvalidRule', 'Rule objects must not contain a ZoneId; the server supplies the verified ZoneId.');
  const ruleIdKey = Object.keys(rule).find((key) => key.toLowerCase() === 'ruleid');
  if (!allowRuleId && ruleIdKey) throw localError('InvalidRule', 'New rules must not include a RuleId.');
  return rule;
}

export async function readZoneRules(client, zoneId) {
  const zone = await resolveAuthorizedZone(client, zoneId);
  const rules = [];
  let offset = 0;
  let totalCount = Infinity;
  let complete = false;
  const limit = 1000;
  for (let page = 0; page < 100 && offset < totalCount; page += 1) {
    const response = await client.DescribeL7AccRules({ ZoneId: zone.ZoneId, Limit: limit, Offset: offset });
    const pageRules = Array.isArray(response?.Rules) ? response.Rules : [];
    totalCount = Number.isFinite(response?.TotalCount) ? response.TotalCount : totalCount;
    rules.push(...pageRules);
    if ((Number.isFinite(totalCount) && rules.length >= totalCount) || pageRules.length < limit) {
      complete = true;
      break;
    }
    offset += limit;
  }
  if (!complete && offset < totalCount) throw localError('TooManyRules', 'Rule list exceeds the supported pagination limit.');
  return { zone, rules: sanitizeRuleData(rules) };
}

export async function listZoneRules(client, zoneId) {
  return (await readZoneRules(client, zoneId)).rules;
}

export async function createL7Rule(client, zoneId, rule) {
  const zone = await resolveAuthorizedZone(client, zoneId);
  const checkedRule = requireRule(rule, { allowRuleId: false });
  const response = await client.CreateL7AccRules({ ZoneId: zone.ZoneId, Rules: [checkedRule] });
  return { ZoneId: zone.ZoneId, ZoneName: zone.ZoneName, RuleIds: response?.RuleIds ?? [] };
}

export async function modifyL7Rule(client, zoneId, ruleId, rule) {
  const zone = await resolveAuthorizedZone(client, zoneId);
  if (typeof ruleId !== 'string' || !ruleId.trim()) throw localError('InvalidRuleId', 'RuleId is required.');
  const checkedRule = requireRule(rule, { allowRuleId: true });
  const providedRuleId = Object.entries(checkedRule).find(([key]) => key.toLowerCase() === 'ruleid')?.[1];
  if (providedRuleId && providedRuleId !== ruleId) {
    throw localError('InvalidRuleId', 'The RuleId in the rule object must match the selected RuleId.');
  }
  const Rule = {
    ...Object.fromEntries(Object.entries(checkedRule).filter(([key]) => key.toLowerCase() !== 'ruleid')),
    RuleId: ruleId,
  };
  await client.ModifyL7AccRule({ ZoneId: zone.ZoneId, Rule });
  return { ZoneId: zone.ZoneId, ZoneName: zone.ZoneName, RuleId: ruleId };
}

export async function deleteL7Rules(client, zoneId, ruleIds) {
  const zone = await resolveAuthorizedZone(client, zoneId);
  validateRuleIds(ruleIds, { max: 50 });
  await client.DeleteL7AccRules({ ZoneId: zone.ZoneId, RuleIds: ruleIds });
  return { ZoneId: zone.ZoneId, ZoneName: zone.ZoneName, deletedCount: ruleIds.length };
}

function validateRuleIds(ruleIds, { max = 1000 } = {}) {
  if (!Array.isArray(ruleIds) || ruleIds.length < 1 || ruleIds.length > max
      || ruleIds.some((id) => typeof id !== 'string' || !id.trim())
      || new Set(ruleIds).size !== ruleIds.length) {
    throw localError('InvalidRuleIds', `Provide 1-${max} unique RuleIds.`);
  }
}

export async function reorderL7Rules(client, zoneId, ruleIds) {
  const { zone, rules } = await readZoneRules(client, zoneId);
  validateRuleIds(ruleIds);
  const currentIds = rules
    .map((rule) => rule?.RuleId)
    .filter((id) => typeof id === 'string');
  if (currentIds.length !== ruleIds.length || currentIds.some((id) => !ruleIds.includes(id))) {
    throw localError('IncompleteRuleOrder', 'RuleIds must contain every current RuleId exactly once.');
  }
  await client.ModifyL7AccRulePriority({ ZoneId: zone.ZoneId, RuleIds: ruleIds });
  return { ZoneId: zone.ZoneId, ZoneName: zone.ZoneName, RuleIds: ruleIds };
}

function cacheHost(target, type) {
  if (typeof target !== 'string' || !target.trim()) throw localError('InvalidCacheTarget', 'Cache targets must be non-empty strings.');
  if (type === 'purge_host') {
    const raw = target.includes('://') ? target : `https://${target}`;
    try { return new URL(raw).hostname.toLowerCase(); } catch { throw localError('InvalidCacheTarget', 'Hostname target is invalid.'); }
  }
  try {
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('protocol');
    return url.hostname.toLowerCase();
  } catch {
    throw localError('InvalidCacheTarget', `${type} targets must be absolute http or https URLs.`);
  }
}

export async function createCachePurge(client, zoneId, { type, targets, method = 'invalidate' }) {
  const zone = await resolveAuthorizedZone(client, zoneId);
  if (!PURGE_TYPES.has(type)) throw localError('InvalidPurgeType', 'Unsupported cache purge type.');
  if (method !== 'invalidate' && method !== 'delete') throw localError('InvalidPurgeMethod', 'Purge method must be invalidate or delete.');

  let normalizedTargets;
  if (type === 'purge_all') {
    if (targets !== undefined && targets.length !== 0) throw localError('InvalidCacheTarget', 'purge_all must not include targets.');
  } else {
    if (!Array.isArray(targets) || targets.length < 1 || targets.length > 100) {
      throw localError('InvalidCacheTarget', 'Provide 1-100 targets for this purge type.');
    }
    normalizedTargets = targets.map((target) => {
      if (type === 'purge_cache_tag') {
        if (typeof target !== 'string' || !target.trim() || target.length > 512) throw localError('InvalidCacheTarget', 'Cache tags must be 1-512 characters.');
        return target;
      }
      return target;
    });
    if (['purge_url', 'purge_prefix', 'purge_host'].includes(type)) {
      normalizedTargets.forEach((target) => {
        const host = cacheHost(target, type);
        const zoneName = zone.ZoneName.toLowerCase();
        if (host !== zoneName && !host.endsWith(`.${zoneName}`)) {
          throw localError('InvalidCacheTarget', `Cache target ${host} is outside the selected Zone.`);
        }
      });
    }
  }

  const request = { ZoneId: zone.ZoneId, Type: type };
  if (normalizedTargets) request.Targets = normalizedTargets;
  if (['purge_prefix', 'purge_host', 'purge_all'].includes(type)) request.Method = method;
  const response = await client.CreatePurgeTask(request);
  return { ZoneId: zone.ZoneId, ZoneName: zone.ZoneName, JobId: response?.JobId ?? null, FailedCount: response?.FailedList?.length ?? 0 };
}

export async function listPurgeTasks(client, zoneId, { jobId, startTime, endTime } = {}) {
  const zone = await resolveAuthorizedZone(client, zoneId);
  const byJob = typeof jobId === 'string' && jobId.trim().length > 0;
  const byTime = typeof startTime === 'string' && startTime.trim().length > 0
    && typeof endTime === 'string' && endTime.trim().length > 0;
  if (byJob === byTime) {
    throw localError('InvalidPurgeQuery', 'Provide either jobId or both startTime and endTime.');
  }
  if (byTime && (Number.isNaN(Date.parse(startTime)) || Number.isNaN(Date.parse(endTime)) || Date.parse(startTime) >= Date.parse(endTime))) {
    throw localError('InvalidPurgeQuery', 'Provide a valid startTime earlier than endTime.');
  }
  const filters = byJob ? [{ Name: 'job-id', Values: [jobId] }] : undefined;
  let offset = 0;
  let totalCount = Infinity;
  let complete = false;
  const tasks = [];
  const limit = 100;
  for (let page = 0; page < 100 && offset < totalCount; page += 1) {
    const request = { ZoneId: zone.ZoneId, Offset: offset, Limit: limit };
    if (filters) request.Filters = filters;
    if (byTime) {
      request.StartTime = startTime;
      request.EndTime = endTime;
    }
    const response = await client.DescribePurgeTasks(request);
    const pageTasks = Array.isArray(response?.Tasks) ? response.Tasks : [];
    totalCount = Number.isFinite(response?.TotalCount) ? response.TotalCount : totalCount;
    tasks.push(...pageTasks.map((task) => Object.fromEntries(
      ['JobId', 'Type', 'Status', 'CreateTime', 'UpdateTime', 'FailType'].filter((key) => task?.[key] !== undefined).map((key) => [key, task[key]]),
    )));
    if ((Number.isFinite(totalCount) && tasks.length >= totalCount) || pageTasks.length < limit) {
      complete = true;
      break;
    }
    offset += limit;
  }
  if (!complete && offset < totalCount) throw localError('TooManyPurgeTasks', 'Purge task list exceeds the supported pagination limit.');
  return { ZoneId: zone.ZoneId, ZoneName: zone.ZoneName, TotalCount: totalCount === Infinity ? tasks.length : totalCount, Tasks: tasks };
}

export function safeApiError(error) {
  const code = typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,120}$/.test(error.code)
    ? error.code
    : 'UnknownError';
  const requestId = typeof error?.requestId === 'string' && /^[A-Za-z0-9-]{1,120}$/.test(error.requestId)
    ? error.requestId
    : undefined;
  return { code, ...(requestId ? { requestId } : {}) };
}
