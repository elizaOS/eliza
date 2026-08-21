# Creates the Windows browser broker pipe with its security descriptor at creation time.
param([Parameter(Mandatory = $true)][string]$PipeName)
$ErrorActionPreference = "Stop"
$options = [System.IO.Pipes.PipeOptions]::Asynchronous -bor
  [System.IO.Pipes.PipeOptions]::WriteThrough -bor
  [System.IO.Pipes.PipeOptions]::CurrentUserOnly
$pipe = [System.IO.Pipes.NamedPipeServerStream]::new(
  $PipeName,
  [System.IO.Pipes.PipeDirection]::InOut,
  1,
  [System.IO.Pipes.PipeTransmissionMode]::Byte,
  $options,
  65536,
  65536
)
[Console]::Error.WriteLine("READY")
$stdin = [Console]::OpenStandardInput()
$stdout = [Console]::OpenStandardOutput()
function Read-Exact([System.IO.Stream]$stream, [int]$count) {
  $buffer = [byte[]]::new($count)
  $offset = 0
  while ($offset -lt $count) {
    $read = $stream.Read($buffer, $offset, $count - $offset)
    if ($read -eq 0) { throw "stream closed" }
    $offset += $read
  }
  return $buffer
}
while ($true) {
  $pipe.WaitForConnection()
  try {
    $header = Read-Exact $pipe 4
    $length = [BitConverter]::ToUInt32($header, 0)
    if ($length -eq 0 -or $length -gt 65536) { throw "invalid frame" }
    $body = Read-Exact $pipe $length
    $stdout.Write($header, 0, 4)
    $stdout.Write($body, 0, $body.Length)
    $stdout.Flush()
    $responseHeader = Read-Exact $stdin 4
    $responseLength = [BitConverter]::ToUInt32($responseHeader, 0)
    if ($responseLength -eq 0 -or $responseLength -gt 65536) { throw "invalid response frame" }
    $responseBody = Read-Exact $stdin $responseLength
    $pipe.Write($responseHeader, 0, 4)
    $pipe.Write($responseBody, 0, $responseBody.Length)
    $pipe.Flush()
  } finally {
    if ($pipe.IsConnected) { $pipe.Disconnect() }
  }
}
