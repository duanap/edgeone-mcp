Add-Type -AssemblyName System.Security -ErrorAction Stop

function ConvertTo-EdgeOneProtectedString {
    param([Parameter(Mandatory = $true)][Security.SecureString]$Value)

    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    $bytes = $null
    try {
        $plainText = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $bytes = [Text.Encoding]::UTF8.GetBytes($plainText)
        $protectedBytes = [Security.Cryptography.ProtectedData]::Protect(
            $bytes,
            $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        return [Convert]::ToBase64String($protectedBytes)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        $plainText = $null
    }
}

function ConvertFrom-EdgeOneProtectedString {
    param([Parameter(Mandatory = $true)][string]$Value)

    $protectedBytes = $null
    $bytes = $null
    try {
        $protectedBytes = [Convert]::FromBase64String($Value)
        $bytes = [Security.Cryptography.ProtectedData]::Unprotect(
            $protectedBytes,
            $null,
            [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        $plainText = [Text.Encoding]::UTF8.GetString($bytes)
        $secure = New-Object Security.SecureString
        foreach ($character in $plainText.ToCharArray()) { $secure.AppendChar($character) }
        $secure.MakeReadOnly()
        return $secure
    } catch {
        throw 'Credential decryption failed for this Windows user.'
    } finally {
        if ($protectedBytes) { [Array]::Clear($protectedBytes, 0, $protectedBytes.Length) }
        if ($bytes) { [Array]::Clear($bytes, 0, $bytes.Length) }
        $plainText = $null
    }
}

function Set-EdgeOnePathAcl {
    param(
        [Parameter(Mandatory = $true)][string]$LiteralPath,
        [Parameter(Mandatory = $true)][bool]$Directory
    )

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    if ($Directory) {
        $item = New-Object IO.DirectoryInfo($LiteralPath)
    } else {
        $item = New-Object IO.FileInfo($LiteralPath)
    }
    $acl = $item.GetAccessControl()
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($acl.GetAccessRules($true, $true, [Security.Principal.NTAccount]))) {
        $acl.RemoveAccessRuleAll($existingRule)
    }

    $inheritance = if ($Directory) {
        [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
    } else {
        [Security.AccessControl.InheritanceFlags]::None
    }
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        $identity,
        [Security.AccessControl.FileSystemRights]::FullControl,
        $inheritance,
        [Security.AccessControl.PropagationFlags]::None,
        [Security.AccessControl.AccessControlType]::Allow
    )
    $acl.SetAccessRule($rule)
    $item.SetAccessControl($acl)
}

function Save-EdgeOneCredential {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][Security.SecureString]$SecretId,
        [Parameter(Mandatory = $true)][Security.SecureString]$SecretKey,
        [Parameter(Mandatory = $true)][string]$Path
    )

    if (-not $IsWindows -and $PSVersionTable.PSVersion.Major -ge 6) {
        throw 'Credential storage requires Windows DPAPI.'
    }
    if ($SecretId.Length -eq 0 -or $SecretKey.Length -eq 0) {
        throw 'Both Tencent Cloud credential fields are required.'
    }

    $directory = [IO.Path]::GetDirectoryName($Path)
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    Set-EdgeOnePathAcl -LiteralPath $directory -Directory $true

    $payload = [ordered]@{
        version = 1
        secretId = ConvertTo-EdgeOneProtectedString -Value $SecretId
        secretKey = ConvertTo-EdgeOneProtectedString -Value $SecretKey
    }
    $temporaryPath = Join-Path $directory ('.credentials-' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $json = ConvertTo-Json -InputObject $payload -Compress
        [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
        Set-EdgeOnePathAcl -LiteralPath $temporaryPath -Directory $false
        Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
        Set-EdgeOnePathAcl -LiteralPath $Path -Directory $false
    } finally {
        if (Test-Path -LiteralPath $temporaryPath) {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
    }
}

function Get-EdgeOneCredential {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'Tencent Cloud credentials have not been saved for this Windows user.'
    }
    try {
        $payload = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
        if ($payload.version -ne 1 -or -not $payload.secretId -or -not $payload.secretKey) {
            throw 'Invalid credential payload.'
        }
        return [pscustomobject]@{
            SecretId = ConvertFrom-EdgeOneProtectedString -Value $payload.secretId
            SecretKey = ConvertFrom-EdgeOneProtectedString -Value $payload.secretKey
        }
    } catch {
        throw 'The local Tencent Cloud credential file could not be decrypted for this Windows user.'
    }
}

Export-ModuleMember -Function Save-EdgeOneCredential, Get-EdgeOneCredential
