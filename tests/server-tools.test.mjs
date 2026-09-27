import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.mjs';

test('free-tier quota tool is read-only and Cache-Tag purge is not exposed', () => {
  const server = createServer({ client: {} });
  const quotaTool = server._registeredTools.edgeone_get_content_quota;
  const purgeTool = server._registeredTools.edgeone_purge_cache;

  assert.ok(quotaTool, 'content quota tool is missing');
  assert.equal(quotaTool.annotations.readOnlyHint, true);
  assert.ok(purgeTool, 'cache purge tool is missing');
  assert.deepEqual(purgeTool.inputSchema.def.shape.type.options, [
    'purge_url', 'purge_prefix', 'purge_host', 'purge_all',
  ]);
});
