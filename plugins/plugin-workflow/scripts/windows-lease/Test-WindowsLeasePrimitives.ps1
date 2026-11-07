# Actual Windows primitives. Not a full survivor/agent integration qualification.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Windows execution required' }
Add-Type -Path (Join-Path $PSScriptRoot 'WindowsLeaseNative.cs')
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = [Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true,$false)
foreach($principal in @($sid,[Security.Principal.SecurityIdentifier]::new('S-1-5-18'))) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
}
$root = Join-Path ([IO.Path]::GetTempPath()) ('eliza-lease-primitives-'+[Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($root,$acl)
$pipe = $null
try {
  # Current-SID ownership grants WRITE_DAC but not WRITE_OWNER. Do not request
  # ownership replacement when only tightening this already-owned DACL.
  $currentRoot=Join-Path $root 'current-owner-without-write-owner'
  $currentAcl=[Security.AccessControl.DirectorySecurity]::new()
  $currentAcl.SetOwner($sid);$currentAcl.SetAccessRuleProtection($true,$false)
  $currentAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'Modify','None','None','Allow'))
  [void][IO.Directory]::CreateDirectory($currentRoot,$currentAcl)
  [WindowsLeaseNative]::ProtectExistingDirectory($currentRoot)
  $currentPin=[WindowsLeaseNative]::LockPrivateDirectory($currentRoot);$currentPin.Dispose()
  if([IO.Directory]::GetAccessControl($currentRoot).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Current state owner changed'}
  # A default elevated token can create a group-owned state root. Normalize
  # only this already-trusted owner, then require the ordinary private guard.
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  try {
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Elevated Windows acceptance token required; owner normalization must not skip'}
      $adminAcl = [Security.AccessControl.DirectorySecurity]::new()
      $adminAcl.SetSecurityDescriptorSddlForm($acl.GetSecurityDescriptorSddlForm('All'))
      $adminAcl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
      $adminRoot = Join-Path $root 'administrator-owned'
      [void][IO.Directory]::CreateDirectory($adminRoot,$adminAcl)
      [WindowsLeaseNative]::ProtectExistingDirectory($adminRoot)
      $pin = [WindowsLeaseNative]::LockPrivateDirectory($adminRoot)
      $pin.Dispose()
      if([IO.Directory]::GetAccessControl($adminRoot).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'State owner was not normalized'}
      # Normalization must never launder an untrusted inherited/access grant.
      $adminAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'),'FullControl','Allow'))
      $untrustedRoot = Join-Path $root 'untrusted-acl'
      [void][IO.Directory]::CreateDirectory($untrustedRoot,$adminAcl)
      $refused=$false
      try {[WindowsLeaseNative]::ProtectExistingDirectory($untrustedRoot)}catch{$refused=$true}
      if(-not $refused){throw 'Untrusted state DACL normalized'}
      if([IO.Directory]::GetAccessControl($untrustedRoot).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne 'S-1-5-32-544'){throw 'Refused state owner was mutated'}
      Write-Output 'Elevated state owner normalization and untrusted ACL refusal passed'
  } finally {$identity.Dispose()}
  $name = 'eliza-workflow-'+[Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N')
  $pipe = [WindowsLeaseNative]::CreatePrivatePipe($name)
  $refused = $false
  try { $duplicate = [WindowsLeaseNative]::CreatePrivatePipe($name); $duplicate.Dispose() } catch { $refused = $true }
  if(-not $refused) { throw 'Duplicate named pipe admitted' }
  $first = Join-Path $root 'first.pending';$target = Join-Path $root 'source.ts'
  [WindowsLeaseNative]::WriteNewPrivateFile($first,[Text.Encoding]::UTF8.GetBytes('original'))
  [WindowsLeaseNative]::PublishNoReplace($first,$target)
  $second=Join-Path $root 'second.pending'
  [WindowsLeaseNative]::WriteNewPrivateFile($second,[Text.Encoding]::UTF8.GetBytes('changed'))
  $refused=$false
  try { [WindowsLeaseNative]::PublishNoReplace($second,$target) } catch { $refused=$true }
  if(-not $refused -or [IO.File]::ReadAllText($target) -ne 'original') { throw 'Published source was replaced' }
  [WindowsLeaseNative]::PublishImmutableSource($target,[Text.Encoding]::UTF8.GetBytes('original'))
  $refused=$false
  try {[WindowsLeaseNative]::PublishImmutableSource($target,[Text.Encoding]::UTF8.GetBytes('changed'))}catch{$refused=$true}
  if(-not $refused){throw 'Immutable source identity check missing'}
  $pipe.Dispose();$pipe=$null
  $capability=[Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N')
  $generation=[Guid]::NewGuid().ToString('N')
  $birth=[WindowsLeaseNative]::ProcessBirth([uint32]$PID)
  $cancel=[Threading.CancellationTokenSource]::new()
  $serving=[WindowsLeaseNative]::Serve($name,$capability,$generation,[uint32]$PID,$birth,$cancel.Token)
  try {
    $reply=[WindowsLeaseNative]::Probe($name,[uint32]$PID,$birth,$capability,$generation).GetAwaiter().GetResult()
    if($reply -ne $generation){throw 'Real named pipe challenge failed'}
    # Delayed readers must receive the response before server disconnect. A
    # missing acknowledgement must time out without retiring the generation.
    foreach($acknowledge in @($true,$false)) {
      $client=[IO.Pipes.NamedPipeClientStream]::new('.', $name, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
      try {
        $client.Connect(1000)
        $challenge=[Guid]::NewGuid().ToString('N')
        $bytes=[Text.Encoding]::UTF8.GetBytes("${capability}:${challenge}`n")
        $client.Write($bytes,0,$bytes.Length)
        Start-Sleep -Milliseconds 250
        $reader=[IO.StreamReader]::new($client)
        $response=$reader.ReadLineAsync()
        if(-not $response.Wait(2000) -or $response.GetAwaiter().GetResult() -ne "${generation}:${challenge}"){throw 'Delayed reader lost challenge response'}
        if($acknowledge) {
          $bytes=[Text.Encoding]::UTF8.GetBytes("ack:${challenge}`n")
          $client.Write($bytes,0,$bytes.Length)
        } else {Start-Sleep -Milliseconds 1400}
      } finally {$client.Dispose()}
      Start-Sleep -Milliseconds 150
      $reply=[WindowsLeaseNative]::Probe($name,[uint32]$PID,$birth,$capability,$generation).GetAwaiter().GetResult()
      if($reply -ne $generation){throw 'Acknowledgement handling retired original generation'}
    }
    # Each rejected client must leave the original generation responsive.
    foreach($mode in @('eof','malformed','silent')) {
      $client=[IO.Pipes.NamedPipeClientStream]::new('.', $name, [IO.Pipes.PipeDirection]::InOut, [IO.Pipes.PipeOptions]::Asynchronous)
      try {
        $client.Connect(1000)
        if($mode -eq 'malformed') {$bytes=[Text.Encoding]::UTF8.GetBytes("invalid`n");$client.Write($bytes,0,$bytes.Length)}
        if($mode -eq 'silent') {Start-Sleep -Milliseconds 1400}
      } finally {$client.Dispose()}
      Start-Sleep -Milliseconds 150
      $reply=[WindowsLeaseNative]::Probe($name,[uint32]$PID,$birth,$capability,$generation).GetAwaiter().GetResult()
      if($reply -ne $generation){throw "Rejected $mode client retired original generation"}
    }
    $wrongPid=$false
    try {[void][WindowsLeaseNative]::Probe($name,[uint32]($PID+1),$birth,$capability,$generation).GetAwaiter().GetResult()}catch{$wrongPid=$true}
    if(-not $wrongPid){throw 'Kernel server PID rejection missing'}
  } finally {
    $cancel.Cancel()
    try {$serving.GetAwaiter().GetResult()}catch{}
    $cancel.Dispose()
  }
  [Console]::WriteLine('PASS: private ACL, exclusive real pipe, peer identity challenge, immutable publication; survivor backend NOT QUALIFIED')
} finally {
  if($null -ne $pipe) { $pipe.Dispose() }
  [IO.Directory]::Delete($root,$true)
}
