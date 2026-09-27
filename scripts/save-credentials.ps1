$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$storePath = Join-Path $env:LOCALAPPDATA 'Codex\edgeone-mcp\credentials.dpapi.json'
$modulePath = Join-Path $PSScriptRoot 'credential-store.psm1'
Import-Module -Name $modulePath -Force

$secretId = $null
$secretKey = $null
$exitCode = 0
try {
    $secretId = Read-Host 'Tencent Cloud SecretId (input hidden)' -AsSecureString
    $secretKey = Read-Host 'Tencent Cloud SecretKey (input hidden)' -AsSecureString
    Save-EdgeOneCredential -SecretId $secretId -SecretKey $secretKey -Path $storePath
    Write-Output 'Credentials encrypted for the current Windows user.'
    Write-Output 'The plaintext values were not displayed or written to Codex config.'
} catch {
    [Console]::Error.WriteLine('Credential storage failed. No values were displayed.')
    $exitCode = 1
} finally {
    if ($secretId) { $secretId.Dispose() }
    if ($secretKey) { $secretKey.Dispose() }
}
exit $exitCode
