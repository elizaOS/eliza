Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
if([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT){throw 'Windows runner required'}
& powershell.exe -NoLogo -NoProfile -NonInteractive -File (Join-Path $PSScriptRoot 'Test-WindowsLeasePrimitives.ps1')
if($LASTEXITCODE -ne 0){throw 'Native primitive acceptance failed'}
& bun test (Join-Path $PSScriptRoot '../../test/windows/windows-survivor.integration.test.ts')
if($LASTEXITCODE -ne 0){throw 'Windows backend survivor acceptance failed'}

& bun test (Join-Path $PSScriptRoot '../../test/windows/windows-helper-startup.integration.test.ts')
if($LASTEXITCODE -ne 0){throw 'Windows helper startup matrix failed'}

& bun test (Join-Path $PSScriptRoot '../../test/windows/windows-smithers-survivor.integration.test.ts')
if($LASTEXITCODE -ne 0){throw 'Windows Smithers survivor acceptance failed'}
