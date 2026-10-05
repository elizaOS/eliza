# Embedded by generate-resources.py; input and capabilities travel only over private stdin.
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$inputLine=[Console]::ReadLine()
if($null -eq $inputLine -or $inputLine.Length -gt 16777216){throw 'Invalid helper input'}
$request=$inputLine|ConvertFrom-Json
$inputLine=$null
function PrivateDirectory([string]$path) {
  # Runtime creates the state directory; strengthen only an existing current-SID owned path
  # while native non-reparse ancestor handles prevent path replacement.
  [WindowsLeaseNative]::ProtectExistingDirectory($path)
}
function Emit($value){[Console]::WriteLine(($value|ConvertTo-Json -Compress -Depth 8));[Console]::Out.Flush()}
if($request.op -eq 'publish'){
  # Match the worker-root normalization below: Windows TEMP may use an 8.3 alias.
  # Reject relative/device/UNC inputs before expanding the native full path.
  if($request.path -notmatch '^[A-Za-z]:[\\/]'){throw 'Local drive path required'}
  $target=[IO.Path]::GetFullPath($request.path)
  PrivateDirectory ([IO.Path]::GetDirectoryName($target))
  [WindowsLeaseNative]::PublishImmutableSource($target,[Convert]::FromBase64String($request.source))
  Emit @{ok=$true};exit
}
$identity=$request.identity
$root=[IO.Path]::GetFullPath($identity.rootDir)
PrivateDirectory $root
$rootPin=[WindowsLeaseNative]::LockPrivateDirectory($root)
try {
  $hash=[Security.Cryptography.SHA256]::Create()
  try{$key=([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity.runId)))).Replace('-','').ToLowerInvariant()}finally{$hash.Dispose()}
  $reservation=Join-Path $root ('.windows-worker-'+$key+'.json')
  if($request.op -eq 'inspect') {
    if(-not [WindowsLeaseNative]::EntryExists($reservation)){Emit @{state='absent'};exit}
    try {
      $record=[Text.Encoding]::UTF8.GetString([WindowsLeaseNative]::ReadPrivateFile($reservation,16384))|ConvertFrom-Json
      if($record.runId -ne $identity.runId -or $record.versionId -ne $identity.versionId -or $record.sourceSha256 -ne $identity.sourceSha256){throw 'Lease identity mismatch'}
      [void][WindowsLeaseNative]::Probe($record.pipe,[uint32]$record.pid,[long]$record.created,$record.capability,$record.generation).GetAwaiter().GetResult()
      Emit @{state='live';generation=$record.generation;pid=$record.workerPid}
    } catch {
      # A canonical finish can atomically settle the record after our initial read.
      # Recheck native visibility under the pinned root; unreadable is never absent.
      $settledDuringProbe=$false
      try {$settledDuringProbe=-not [WindowsLeaseNative]::EntryExists($reservation)}catch{}
      if($settledDuringProbe){Emit @{state='absent'}}
      else {Emit @{state='unknown';reason='Windows worker reservation cannot be authenticated'}}
    }
    exit
  }
  if($request.op -ne 'acquire'){throw 'Unknown operation'}
  $generation=[Guid]::NewGuid().ToString('N')
  $capability=[byte[]]::new(32);$rng=[Security.Cryptography.RandomNumberGenerator]::Create();try{$rng.GetBytes($capability)}finally{$rng.Dispose()}
  $capability=([BitConverter]::ToString($capability)).Replace('-','').ToLowerInvariant()
  $pipe='eliza-workflow-'+[Guid]::NewGuid().ToString('N')+[Guid]::NewGuid().ToString('N')
  $record=@{schemaVersion=1;generation=$generation;capability=$capability;pipe=$pipe;pid=$PID;created=[WindowsLeaseNative]::ProcessBirth([uint32]$PID);workerPid=$request.workerPid;runId=$identity.runId;versionId=$identity.versionId;sourceSha256=$identity.sourceSha256}
  # CREATE_NEW is the durable exclusive reservation, including when another process starts concurrently.
  # A partial record remains unknown and must never be removed by a retry.
  [WindowsLeaseNative]::WriteNewPrivateFile($reservation,[Text.Encoding]::UTF8.GetBytes(($record|ConvertTo-Json -Compress)))
  $stop=[Threading.CancellationTokenSource]::new()
  $serving=[WindowsLeaseNative]::Serve($pipe,$capability,$generation,[uint32]$request.workerPid,[WindowsLeaseNative]::ProcessBirth([uint32]$request.workerPid),$stop.Token)
  try {
    if($serving.IsCompleted){[void]$serving.GetAwaiter().GetResult();throw 'Responder unavailable'}
    Emit @{ready=$true;generation=$generation}
    $lineTask=[Console]::In.ReadLineAsync()
    [void][Threading.Tasks.Task]::WhenAny($lineTask,$serving).GetAwaiter().GetResult()
    if(-not $lineTask.IsCompleted){throw 'Lease responder stopped'}
    $command=$lineTask.GetAwaiter().GetResult()
    if($command -eq 'finish') {
      $current=[Text.Encoding]::UTF8.GetString([WindowsLeaseNative]::ReadPrivateFile($reservation,16384))|ConvertFrom-Json
      if($current.generation -ne $generation){throw 'Reservation changed'}
      [WindowsLeaseNative]::PublishNoReplace($reservation,($reservation+'.settled-'+$generation))
      $stop.Cancel();[void]$serving.GetAwaiter().GetResult()
      Emit @{finished=$true}
    } elseif($command -ne 'abandon' -and $null -ne $command){throw 'Invalid completion command'}
    if($command -ne 'finish'){$stop.Cancel();try{[void]$serving.GetAwaiter().GetResult()}catch{}}
    # EOF/abandon/worker loss leaves the original reservation as durable unknown.
  } finally {$stop.Cancel();$stop.Dispose()}
} finally {$rootPin.Dispose()}
