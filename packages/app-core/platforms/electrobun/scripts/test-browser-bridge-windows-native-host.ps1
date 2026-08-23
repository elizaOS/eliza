# Compiles the Windows native host, stages its adjacent DPAPI helper, and proves the packaged lookup path is live.
$ErrorActionPreference = "Stop"
$electrobunRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$tempRoot = Join-Path $env:TEMP ("eliza-browser-host-proof-" + [Guid]::NewGuid().ToString("N"))
$stageRoot = Join-Path $tempRoot "stage"
$stateRoot = Join-Path $tempRoot "state"
$nativeHost = Join-Path $stageRoot "browser-bridge-native-host.exe"
$secretHelperSource = Join-Path $PSScriptRoot "browser-bridge-secret.ps1"
$secretHelper = Join-Path $stageRoot "browser-bridge-secret.ps1"
$secretPath = Join-Path $stateRoot "browser-bridge\broker-secret"
$extensionId = "abcdefghijklmnopabcdefghijklmnop"
$requestId = "123e4567-e89b-42d3-a456-426614174000"

try {
  [void][System.IO.Directory]::CreateDirectory($stageRoot)
  Push-Location $electrobunRoot
  try {
    & bun build --compile --minify --target bun-windows-x64 `
      "src/native/browser-bridge-native-host-main.ts" `
      --outfile $nativeHost
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $nativeHost -PathType Leaf)) {
      throw "compiled Windows browser native host was not produced"
    }
  } finally {
    Pop-Location
  }

  Copy-Item -LiteralPath $secretHelperSource -Destination $secretHelper
  $createdSecret = & powershell.exe -NoLogo -NoProfile -NonInteractive `
    -ExecutionPolicy Bypass -File $secretHelper -Operation get-or-create -Path $secretPath
  if ($LASTEXITCODE -ne 0 -or [Convert]::FromBase64String([string]$createdSecret).Length -ne 32) {
    throw "staged DPAPI broker secret creation failed"
  }

  $request = @{
    v = 1
    type = "browser_bridge.enroll"
    requestId = $requestId
    nonce = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM"
    browser = "chrome"
    extensionId = $extensionId
    extensionVersion = "1.2.3"
    profileId = "123e4567-e89b-42d3-a456-426614174001"
  } | ConvertTo-Json -Compress
  $requestBytes = [Text.Encoding]::UTF8.GetBytes($request)
  $requestHeader = [BitConverter]::GetBytes([uint32]$requestBytes.Length)

  $start = New-Object System.Diagnostics.ProcessStartInfo
  $start.FileName = $nativeHost
  $start.Arguments = "chrome-extension://$extensionId/"
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  # Keep the binary native-messaging header at byte zero under Windows
  # PowerShell 5.1; the default redirected writer emits a UTF-8 BOM.
  $start.StandardInputEncoding = New-Object System.Text.UTF8Encoding($false)
  $start.EnvironmentVariables["ELIZA_STATE_DIR"] = $stateRoot
  $start.EnvironmentVariables["ELIZA_BROWSER_BRIDGE_CHROME_EXTENSION_IDS"] = $extensionId
  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $start
  if (-not $process.Start()) { throw "compiled Windows browser native host did not start" }
  try {
    $process.StandardInput.BaseStream.Write($requestHeader, 0, $requestHeader.Length)
    $process.StandardInput.BaseStream.Write($requestBytes, 0, $requestBytes.Length)
    $process.StandardInput.BaseStream.Flush()
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(15000)) {
      $process.Kill()
      throw "compiled Windows browser native host timed out"
    }
    $stderr = $process.StandardError.ReadToEnd()
    $stdout = New-Object System.IO.MemoryStream
    try {
      $process.StandardOutput.BaseStream.CopyTo($stdout)
      $responseFrame = $stdout.ToArray()
    } finally {
      $stdout.Dispose()
    }
    if ($process.ExitCode -ne 0 -or $responseFrame.Length -lt 5) {
      throw "compiled Windows browser native host failed: $stderr"
    }
    $responseLength = [BitConverter]::ToUInt32($responseFrame, 0)
    if ($responseLength -eq 0 -or $responseFrame.Length -ne $responseLength + 4) {
      throw "compiled Windows browser native host returned an invalid native-message frame"
    }
    $responseJson = [Text.Encoding]::UTF8.GetString($responseFrame, 4, $responseLength)
    $response = $responseJson | ConvertFrom-Json
    if ($response.requestId -ne $requestId -or $response.type -ne "browser_bridge.error") {
      throw "compiled Windows browser native host returned an unbound response"
    }
    if ($response.code -eq "app_not_running") {
      throw "compiled Windows browser native host did not resolve its adjacent DPAPI helper"
    }
    if ($response.code -ne "broker_unavailable" -or -not $response.retryable) {
      throw "compiled Windows browser native host returned an unexpected result: $responseJson"
    }
  } finally {
    if (-not $process.HasExited) { $process.Kill() }
    $process.Dispose()
  }
  Write-Output "staged compiled Windows browser native host resolved its adjacent DPAPI helper"
} finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}
