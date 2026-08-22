# Executes Windows PowerShell 5.1 compatibility and security probes for broker helpers.
$ErrorActionPreference = "Stop"
$secretHelper = Join-Path $PSScriptRoot "browser-bridge-secret.ps1"
$pipeHelper = Join-Path $PSScriptRoot "browser-bridge-pipe-host.ps1"
$tempRoot = Join-Path $env:TEMP ("eliza-browser-bridge-" + [Guid]::NewGuid().ToString("N"))
$secretPath = Join-Path $tempRoot "state\browser-bridge\broker-secret"
function Read-Exact([System.IO.Stream]$Stream, [int]$Count) {
  $buffer = [byte[]]::new($Count)
  $offset = 0
  while ($offset -lt $Count) {
    $read = $Stream.Read($buffer, $offset, $Count - $offset)
    if ($read -eq 0) { throw "probe stream closed" }
    $offset += $read
  }
  return $buffer
}
function Invoke-SecurePipeRoundTrip {
  $pipeName = "eliza-probe-" + [Guid]::NewGuid().ToString("N")
  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = "powershell.exe"
  $escapedHelper = $pipeHelper.Replace('"', '\"')
  $start.Arguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$escapedHelper`" -PipeName $pipeName"
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  if (-not $process.Start()) { throw "secure pipe helper did not start" }
  $client = $null
  try {
    $readyLine = $process.StandardError.ReadLine()
    if ($readyLine -ne "READY") {
      throw "secure pipe helper did not become ready: $readyLine"
    }
    $client = New-Object System.IO.Pipes.NamedPipeClientStream(
      ".",
      $pipeName,
      [System.IO.Pipes.PipeDirection]::InOut,
      [System.IO.Pipes.PipeOptions]::None
    )
    $client.Connect(5000)
    $request = [Text.Encoding]::UTF8.GetBytes('{"probe":"request"}')
    $requestHeader = [BitConverter]::GetBytes([uint32]$request.Length)
    $client.Write($requestHeader, 0, 4)
    $client.Write($request, 0, $request.Length)
    $client.Flush()
    $forwardedHeader = Read-Exact $process.StandardOutput.BaseStream 4
    $forwardedLength = [BitConverter]::ToUInt32($forwardedHeader, 0)
    $forwarded = Read-Exact $process.StandardOutput.BaseStream $forwardedLength
    if ([Text.Encoding]::UTF8.GetString($forwarded) -ne '{"probe":"request"}') {
      throw "secure pipe request forwarding mismatch"
    }
    $response = [Text.Encoding]::UTF8.GetBytes('{"probe":"response"}')
    $responseHeader = [BitConverter]::GetBytes([uint32]$response.Length)
    $process.StandardInput.BaseStream.Write($responseHeader, 0, 4)
    $process.StandardInput.BaseStream.Write($response, 0, $response.Length)
    $process.StandardInput.BaseStream.Flush()
    $receivedHeader = Read-Exact $client 4
    $receivedLength = [BitConverter]::ToUInt32($receivedHeader, 0)
    $received = Read-Exact $client $receivedLength
    if ([Text.Encoding]::UTF8.GetString($received) -ne '{"probe":"response"}') {
      throw "secure pipe response forwarding mismatch"
    }
  } finally {
    if ($null -ne $client) { $client.Dispose() }
    if (-not $process.HasExited) { $process.Kill() }
    $process.Dispose()
  }
}
try {
  $first = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $secretHelper -Operation get-or-create -Path $secretPath
  if ($LASTEXITCODE -ne 0) { throw "DPAPI create probe failed" }
  $second = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $secretHelper -Operation read -Path $secretPath
  if ($LASTEXITCODE -ne 0 -or $first -ne $second -or [Convert]::FromBase64String($first).Length -ne 32) {
    throw "DPAPI reopen probe failed"
  }
  $directoryAcl = Get-Acl -LiteralPath (Split-Path $secretPath -Parent)
  $fileAcl = Get-Acl -LiteralPath $secretPath
  if (-not $directoryAcl.AreAccessRulesProtected -or -not $fileAcl.AreAccessRulesProtected) {
    throw "broker secret ACLs are not protected"
  }
  $probe = & powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $pipeHelper -PipeName ("eliza-probe-" + [Guid]::NewGuid().ToString("N")) -ContractProbe
  if ($LASTEXITCODE -ne 0 -or $probe -notmatch "PIPE_REJECT_REMOTE_CLIENTS") {
    throw "secure pipe helper compilation probe failed"
  }
  Invoke-SecurePipeRoundTrip
  Write-Output "browser bridge Windows security probes passed"
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
