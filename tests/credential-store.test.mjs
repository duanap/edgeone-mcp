import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const modulePath = resolve('scripts/credential-store.psm1');
const powershell = process.env.WINDIR
  ? resolve(process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  : 'powershell.exe';

test('DPAPI credential storage encrypts values and restricts file access', () => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$modulePath = '${modulePath.replaceAll("'", "''")}'
if (-not (Test-Path -LiteralPath $modulePath)) {
  Write-Output '{"status":"module-missing"}'
  exit 0
}
Import-Module -Name $modulePath -Force
$tmp = Join-Path $env:TEMP ('edgeone-mcp-test-' + [guid]::NewGuid().ToString('N'))
$path = Join-Path $tmp 'credentials.dpapi.json'
function New-TestSecureString([string]$Value) {
  $secure = New-Object Security.SecureString
  foreach ($character in $Value.ToCharArray()) { $secure.AppendChar($character) }
  $secure.MakeReadOnly()
  return $secure
}
$fakeId = 'fake-secret-id-for-test'
$fakeKey = 'fake-secret-key-for-test'
try {
  $id = New-TestSecureString $fakeId
  $key = New-TestSecureString $fakeKey
  Save-EdgeOneCredential -SecretId $id -SecretKey $key -Path $path
  $persisted = Get-Content -LiteralPath $path -Raw
  $encrypted = ($persisted -notlike ('*' + $fakeId + '*')) -and ($persisted -notlike ('*' + $fakeKey + '*'))
  $loaded = Get-EdgeOneCredential -Path $path
  $idPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($loaded.SecretId)
  $keyPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($loaded.SecretKey)
  try {
    $roundTrip = ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($idPtr) -ceq $fakeId) -and ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPtr) -ceq $fakeKey)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($idPtr)
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPtr)
  }
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $fileInfo = New-Object IO.FileInfo($path)
  $acl = $fileInfo.GetAccessControl()
  $accessRules = $acl.GetAccessRules($true, $true, [Security.Principal.NTAccount])
  $unexpected = @($accessRules | Where-Object { $_.IdentityReference.Value -ne $identity }).Count
  $restricted = $acl.AreAccessRulesProtected -and $unexpected -eq 0
  if ($encrypted -and $roundTrip -and $restricted) {
    Write-Output '{"status":"ok","encrypted":true,"roundTrip":true,"restrictedAcl":true}'
  } else {
    Write-Output '{"status":"failed","encrypted":false,"roundTrip":false,"restrictedAcl":false}'
  }
} finally {
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
}
`;

  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.notEqual(result.stdout.trim(), '', result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    status: 'ok',
    encrypted: true,
    roundTrip: true,
    restrictedAcl: true,
  });
  assert.equal(result.stdout.includes('fake-secret-'), false);
  assert.equal(result.stderr.includes('fake-secret-'), false);
});
