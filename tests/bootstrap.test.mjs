import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const modulePath = resolve('scripts/credential-store.psm1');
const bootstrapPath = resolve('src/bootstrap.mjs');
const powershell = process.env.WINDIR
  ? resolve(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

test('Node bootstrap loads DPAPI credentials and keeps MCP stdio on the Node process', async () => {
  const tempDirectory = mkdtempSync(join(tmpdir(), 'edgeone-mcp-bootstrap-'));
  const credentialPath = join(tempDirectory, 'credentials.dpapi.json');
  const fakeId = 'fake-bootstrap-id-not-real';
  const fakeKey = 'fake-bootstrap-key-not-real';
  const setupScript = String.raw`
$ErrorActionPreference = 'Stop'
$modulePath = '${modulePath.replaceAll("'", "''")}'
Import-Module -Name $modulePath -Force
function New-TestSecureString([string]$Value) {
  $secure = New-Object Security.SecureString
  foreach ($character in $Value.ToCharArray()) { $secure.AppendChar($character) }
  $secure.MakeReadOnly()
  return $secure
}
Save-EdgeOneCredential -SecretId (New-TestSecureString '${fakeId}') -SecretKey (New-TestSecureString '${fakeKey}') -Path '${credentialPath.replaceAll("'", "''")}'
`;
  const setup = spawnSync(powershell, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    Buffer.from(setupScript, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true });
  assert.ifError(setup.error);
  assert.equal(setup.status, 0, setup.stderr);

  const client = new Client({ name: 'edgeone-bootstrap-test', version: '0.0.1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [bootstrapPath],
    env: { ...process.env, EDGEONE_CREDENTIAL_FILE: credentialPath },
  });

  try {
    await client.connect(transport);
    const result = await client.listTools();
    const names = result.tools.map(({ name }) => name).sort();
    assert.deepEqual(names, [
      'edgeone_create_l7_rule',
      'edgeone_delete_l7_rules',
      'edgeone_list_l7_rules',
      'edgeone_list_purge_tasks',
      'edgeone_list_zones',
      'edgeone_modify_l7_rule',
      'edgeone_purge_cache',
      'edgeone_reorder_l7_rules',
    ]);
    const zoneList = result.tools.find(({ name }) => name === 'edgeone_list_zones');
    assert.deepEqual(zoneList.inputSchema.properties ?? {}, {});
    for (const tool of result.tools.filter(({ name }) => name !== 'edgeone_list_zones')) {
      assert.ok(tool.inputSchema.properties?.zoneId, `${tool.name} must require a ZoneId`);
    }
    for (const tool of result.tools.filter(({ name }) => [
      'edgeone_create_l7_rule',
      'edgeone_modify_l7_rule',
      'edgeone_delete_l7_rules',
      'edgeone_reorder_l7_rules',
      'edgeone_purge_cache',
    ].includes(name))) {
      assert.equal(tool.annotations?.destructiveHint, true, `${tool.name} must be marked high impact`);
    }
    assert.equal(JSON.stringify(result).includes(fakeId), false);
    assert.equal(JSON.stringify(result).includes(fakeKey), false);
  } finally {
    try { await client.close(); } catch {}
    rmSync(tempDirectory, { recursive: true, force: true });
  }
});
