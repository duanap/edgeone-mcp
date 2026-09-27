import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  createCachePurge,
  createL7Rule,
  createTeoClient,
  deleteL7Rules,
  listAuthorizedZones,
  listPurgeTasks,
  modifyL7Rule,
  readZoneRules,
  reorderL7Rules,
  safeApiError,
} from './edgeone-client.mjs';

const zoneIdSchema = z.string().regex(/^zone-[A-Za-z0-9-]+$/, 'Select a ZoneId returned by edgeone_list_zones.');
const ruleSchema = z.record(z.string(), z.unknown());
const ruleIdsSchema = z.array(z.string().min(1)).min(1).max(50);

function toErrorResult(error) {
  const safe = safeApiError(error);
  const requestSuffix = safe.requestId ? `; requestId=${safe.requestId}` : '';
  const localMessage = error?.name === 'EdgeOneInputError' && typeof error.message === 'string'
    ? `: ${error.message}`
    : '';
  return {
    isError: true,
    content: [{ type: 'text', text: `EdgeOne request failed (${safe.code})${localMessage}${requestSuffix}` }],
  };
}

function responseFor(work) {
  return async (args) => {
    try {
      const result = await work(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: Array.isArray(result) ? { items: result } : result,
      };
    } catch (error) {
      return toErrorResult(error);
    }
  };
}

export function createServer({ client = createTeoClient() } = {}) {
  const server = new McpServer({ name: 'duanap-edgeone', version: '0.2.0' });
  const highImpactAnnotations = { readOnlyHint: false, openWorldHint: false, destructiveHint: true };

  server.registerTool('edgeone_list_zones', {
    title: 'List EdgeOne Zones',
    description: 'List Zones available to the connected Tencent CAM identity. Use the returned ZoneId for all per-Zone tools.',
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, responseFor(() => listAuthorizedZones(client)));

  server.registerTool('edgeone_list_l7_rules', {
    title: 'List L7 Rules',
    description: 'Read L7 rules for one ZoneId returned by edgeone_list_zones. Sensitive header values are redacted.',
    inputSchema: { zoneId: zoneIdSchema },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, responseFor(({ zoneId }) => readZoneRules(client, zoneId)));

  server.registerTool('edgeone_create_l7_rule', {
    title: 'Create L7 Rule',
    description: 'Creates one L7 rule in the selected Zone. This changes live traffic handling; call only after the user approves the exact rule content.',
    inputSchema: { zoneId: zoneIdSchema, rule: ruleSchema },
    annotations: highImpactAnnotations,
  }, responseFor(({ zoneId, rule }) => createL7Rule(client, zoneId, rule)));

  server.registerTool('edgeone_modify_l7_rule', {
    title: 'Modify L7 Rule',
    description: 'Replaces one L7 rule in the selected Zone. This changes live traffic handling; call only after the user approves the exact replacement.',
    inputSchema: { zoneId: zoneIdSchema, ruleId: z.string().min(1), rule: ruleSchema },
    annotations: { ...highImpactAnnotations, idempotentHint: true },
  }, responseFor(({ zoneId, ruleId, rule }) => modifyL7Rule(client, zoneId, ruleId, rule)));

  server.registerTool('edgeone_delete_l7_rules', {
    title: 'Delete L7 Rules',
    description: 'Deletes the listed rules from one Zone. This is destructive; call only after the user approves the exact ZoneId and RuleIds.',
    inputSchema: { zoneId: zoneIdSchema, ruleIds: ruleIdsSchema },
    annotations: highImpactAnnotations,
  }, responseFor(({ zoneId, ruleIds }) => deleteL7Rules(client, zoneId, ruleIds)));

  server.registerTool('edgeone_reorder_l7_rules', {
    title: 'Reorder L7 Rules',
    description: 'Changes execution priority for every L7 rule in one Zone. This can change live request handling; call only after user approval.',
    inputSchema: { zoneId: zoneIdSchema, ruleIds: z.array(z.string().min(1)).min(1).max(1000) },
    annotations: highImpactAnnotations,
  }, responseFor(({ zoneId, ruleIds }) => reorderL7Rules(client, zoneId, ruleIds)));

  server.registerTool('edgeone_purge_cache', {
    title: 'Purge EdgeOne Cache',
    description: 'Creates a cache purge task within one verified Zone. purge_all affects the entire selected Zone; obtain explicit user approval for every purge, especially purge_all.',
    inputSchema: {
      zoneId: zoneIdSchema,
      type: z.enum(['purge_url', 'purge_prefix', 'purge_host', 'purge_all', 'purge_cache_tag']),
      targets: z.array(z.string().min(1)).max(100).optional(),
      method: z.enum(['invalidate', 'delete']).optional(),
    },
    annotations: highImpactAnnotations,
  }, responseFor(({ zoneId, type, targets, method }) => createCachePurge(client, zoneId, { type, targets, method })));

  server.registerTool('edgeone_list_purge_tasks', {
    title: 'List EdgeOne Purge Tasks',
    description: 'Read purge-task status for one verified Zone. Provide either jobId or both startTime and endTime.',
    inputSchema: {
      zoneId: zoneIdSchema,
      jobId: z.string().min(1).optional(),
      startTime: z.string().min(1).optional(),
      endTime: z.string().min(1).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, responseFor(({ zoneId, jobId, startTime, endTime }) => listPurgeTasks(client, zoneId, { jobId, startTime, endTime })));

  return server;
}

export async function startServer(options = {}) {
  const server = createServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startServer().catch((error) => {
    const safe = safeApiError(error);
    console.error(`EdgeOne MCP startup failed (${safe.code}).`);
    process.exitCode = 1;
  });
}
