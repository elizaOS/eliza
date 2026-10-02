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
