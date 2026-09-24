# Removes only Chrome and Firefox native-host registrations owned by this installation.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$ConfigDir = (Join-Path $env:LOCALAPPDATA "elizaOS\BrowserBridge")
)

$ErrorActionPreference = "Stop"
$hostName = "ai.elizaos.browserbridge"
$expectedHostPath = [System.IO.Path]::GetFullPath(
  (Join-Path $InstallDir "Resources\app\browser-bridge-native-host.exe")
)

function Get-DefaultRegistryValue([string]$SubKey) {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($SubKey, $false)
  if ($null -eq $key) { return $null }
  try {
    return $key.GetValue(
      $null,
      $null,
      [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    )
  } finally {
    $key.Dispose()
  }
}

function Test-ManifestOwnership([string]$ManifestPath) {
  if (-not [System.IO.File]::Exists($ManifestPath)) { return $null }
  try {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
    if ($manifest.name -ne $hostName -or -not $manifest.path) { return $false }
    $manifestHostPath = [System.IO.Path]::GetFullPath([string]$manifest.path)
    return [System.String]::Equals(
      $manifestHostPath,
      $expectedHostPath,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  } catch {
    return $false
  }
}

$registrations = @(
  @{
    Browser = "chrome"
    RegistrySubKey = "Software\Google\Chrome\NativeMessagingHosts\$hostName"
  },
  @{
    Browser = "firefox"
    RegistrySubKey = "Software\Mozilla\NativeMessagingHosts\$hostName"
  }
)

foreach ($registration in $registrations) {
  $manifestPath = [System.IO.Path]::GetFullPath(
    (Join-Path $ConfigDir "$($registration.Browser)\$hostName.json")
  )
  $registeredPath = Get-DefaultRegistryValue $registration.RegistrySubKey
  $registryOwnsManifest = $null -ne $registeredPath -and
    [System.String]::Equals(
      [System.IO.Path]::GetFullPath([string]$registeredPath),
      $manifestPath,
      [System.StringComparison]::OrdinalIgnoreCase
    )
  $manifestOwned = Test-ManifestOwnership $manifestPath

  if ($registryOwnsManifest -and $manifestOwned -eq $true) {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree(
      $registration.RegistrySubKey,
      $false
    )
  }
  if ($registryOwnsManifest -and $manifestOwned -eq $true) {
    Remove-Item -LiteralPath $manifestPath -Force
  }
}

foreach ($directory in @(
  (Join-Path $ConfigDir "chrome"),
  (Join-Path $ConfigDir "firefox"),
  $ConfigDir
)) {
  if (
    [System.IO.Directory]::Exists($directory) -and
    (Get-ChildItem -LiteralPath $directory -Force | Select-Object -First 1).Count -eq 0
  ) {
    Remove-Item -LiteralPath $directory -Force
  }
}
