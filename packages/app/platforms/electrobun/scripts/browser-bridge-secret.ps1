# Stores the Windows broker HMAC key under DPAPI CurrentUser and a protected DACL.
param(
  [Parameter(Mandatory = $true)][ValidateSet("read", "get-or-create")][string]$Operation,
  [Parameter(Mandatory = $true)][string]$Path
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Security
function Assert-No-ReparseTraversal([string]$TargetPath) {
  $full = [System.IO.Path]::GetFullPath($TargetPath)
  $root = [System.IO.Path]::GetPathRoot($full)
  $relative = $full.Substring($root.Length)
  $current = $root
  foreach ($part in $relative.Split([System.IO.Path]::DirectorySeparatorChar)) {
    if ([String]::IsNullOrEmpty($part)) { continue }
    $current = [System.IO.Path]::Combine($current, $part)
    $parent = [System.IO.Path]::GetDirectoryName($current)
    $leaf = [System.IO.Path]::GetFileName($current)
    $item = if ([String]::IsNullOrEmpty($parent)) { $null } else {
      Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq $leaf } |
        Select-Object -First 1
    }
    if ($null -ne $item) {
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "broker secret path traverses a reparse point"
      }
    }
  }
}
function New-CurrentUserAcl([bool]$Directory) {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $sid = $identity.User
  if ($null -eq $sid) { throw "current-user SID unavailable" }
  if ($Directory) {
    $acl = New-Object System.Security.AccessControl.DirectorySecurity
    $inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor
      [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
  } else {
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
  }
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($rule)
  $systemSid = New-Object System.Security.Principal.SecurityIdentifier("S-1-5-18")
  $systemRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
    $systemSid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  $acl.AddAccessRule($systemRule)
  $acl.SetOwner($sid)
  return $acl
}
function Assert-CurrentUserAcl([string]$TargetPath, [bool]$Directory) {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
  $userSid = $identity.User.Value
  $systemSid = "S-1-5-18"
  $acl = if ($Directory) {
    [System.IO.Directory]::GetAccessControl($TargetPath)
  } else {
    [System.IO.File]::GetAccessControl($TargetPath)
  }
  if (-not $acl.AreAccessRulesProtected) { throw "broker secret ACL inherits permissions" }
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($owner -ne $userSid) { throw "broker secret ACL owner mismatch" }
  foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    $sid = $rule.IdentityReference.Value
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or
        ($sid -ne $userSid -and $sid -ne $systemSid)) {
      throw "broker secret ACL grants an unexpected principal"
    }
  }
}
$fullPath = [System.IO.Path]::GetFullPath($Path)
$directory = [System.IO.Path]::GetDirectoryName($fullPath)
if ([String]::IsNullOrEmpty($directory)) { throw "broker secret directory unavailable" }
Assert-No-ReparseTraversal $directory
if (-not [System.IO.Directory]::Exists($directory)) {
  $directoryAcl = New-CurrentUserAcl $true
  [void][System.IO.Directory]::CreateDirectory($directory, $directoryAcl)
}
Assert-CurrentUserAcl $directory $true
Assert-No-ReparseTraversal $fullPath
if (-not [System.IO.File]::Exists($fullPath)) {
  if ($Operation -eq "read") { throw "broker secret missing" }
  $secret = [byte[]]::new(32)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($secret)
  } finally {
    $rng.Dispose()
  }
  $protected = [System.Security.Cryptography.ProtectedData]::Protect(
    $secret,
    $null,
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  try {
    $fileAcl = New-CurrentUserAcl $false
    $stream = [System.IO.FileStream]::new(
      $fullPath,
      [System.IO.FileMode]::CreateNew,
      [System.Security.AccessControl.FileSystemRights]::Write,
      [System.IO.FileShare]::None,
      4096,
      [System.IO.FileOptions]::WriteThrough,
      $fileAcl
    )
    try {
      $stream.Write($protected, 0, $protected.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }
  } catch [System.IO.IOException] {
    if (-not [System.IO.File]::Exists($fullPath)) { throw }
  }
}
Assert-No-ReparseTraversal $fullPath
Assert-CurrentUserAcl $fullPath $false
$ciphertext = [System.IO.File]::ReadAllBytes($fullPath)
$plaintext = [System.Security.Cryptography.ProtectedData]::Unprotect(
  $ciphertext,
  $null,
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
if ($plaintext.Length -ne 32) { throw "broker secret has invalid length" }
[Console]::Out.Write([Convert]::ToBase64String($plaintext))
