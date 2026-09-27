import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTeoClient, listAuthorizedZones, safeApiError } from './edgeone-client.mjs';
import { startServer } from './server.mjs';
import { verifyEdgeOne } from './verify-edgeone.mjs';

function powershellExecutable(env) {
  const windowsDirectory = env.WINDIR || env.SystemRoot || 'C:\\Windows';
  return join(windowsDirectory, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function decryptLocalCredentials(env = process.env) {
  const credentialPath = env.EDGEONE_CREDENTIAL_FILE
    || join(env.LOCALAPPDATA || '', 'Codex', 'edgeone-mcp', 'credentials.dpapi.json');
  if (!credentialPath || !existsSync(credentialPath)) {
    throw new Error('No local DPAPI credential file is available for this Windows user.');
  }

  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security -ErrorAction Stop
$payload = Get-Content -LiteralPath $env:EDGEONE_CREDENTIAL_FILE -Raw | ConvertFrom-Json
if ($payload.version -ne 1 -or -not $payload.secretId -or -not $payload.secretKey) { throw 'Invalid local credential payload.' }
$idBytes = $null
$keyBytes = $null
try {
  $idBytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($payload.secretId), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $keyBytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($payload.secretKey), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  $result = [ordered]@{
    secretId = [Text.Encoding]::UTF8.GetString($idBytes)
    secretKey = [Text.Encoding]::UTF8.GetString($keyBytes)
  }
  [Console]::Out.Write((ConvertTo-Json -InputObject $result -Compress))
} finally {
  if ($idBytes) { [Array]::Clear($idBytes, 0, $idBytes.Length) }
  if ($keyBytes) { [Array]::Clear($keyBytes, 0, $keyBytes.Length) }
  $result = $null
}
`;
  const childEnvironment = { ...env, EDGEONE_CREDENTIAL_FILE: resolve(credentialPath) };
  const result = spawnSync(powershellExecutable(env), [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ], {
    encoding: 'utf8',
    env: childEnvironment,
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });

  if (result.error || result.status !== 0) {
    throw new Error('The local DPAPI credential file could not be decrypted for this Windows user.');
  }
  let credentials;
  try {
    credentials = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error('The local DPAPI credential helper returned an invalid response.');
  }
  if (typeof credentials.secretId !== 'string' || !credentials.secretId
      || typeof credentials.secretKey !== 'string' || !credentials.secretKey) {
    throw new Error('The local DPAPI credential file is incomplete.');
  }
  result.stdout = '';
  result.stderr = '';
  return credentials;
}

export async function runBootstrap({ env = process.env, argv = process.argv.slice(2) } = {}) {
  const credentials = decryptLocalCredentials(env);
  const client = createTeoClient(credentials);
  credentials.secretId = '';
  credentials.secretKey = '';

  if (argv.includes('--verify')) {
    const result = await verifyEdgeOne(client);
    console.log(JSON.stringify(result));
    return result;
  }

  return startServer({ client });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runBootstrap().catch((error) => {
    const safe = safeApiError(error);
    const requestSuffix = safe.requestId ? `; requestId=${safe.requestId}` : '';
    console.error(`EdgeOne bootstrap failed (${safe.code})${requestSuffix}.`);
    process.exitCode = 1;
  });
}
