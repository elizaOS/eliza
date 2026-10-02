// Read-only observations of two fixture-owned PIDs; no process termination.
import { spawnSync } from 'node:child_process';
import { win32 } from 'node:path';

export type OwnedProcessObservation = { present: boolean; birth: string | null };
export function observeOwnedWindowsProcesses(
  workerPid: number,
  helperPid: number
): {
  worker: OwnedProcessObservation;
  helper: OwnedProcessObservation;
} {
  if (
    process.platform !== 'win32' ||
    ![workerPid, helperPid].every((pid) => Number.isSafeInteger(pid) && pid > 0)
  )
    throw Error('Invalid owned process observer input');
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) throw Error('Windows installation unavailable');
  const script = `$ErrorActionPreference='Stop'
Import-Module ($PSHOME+'\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
function Observe([int]$ownedId) {
  try {
    $owned=[Diagnostics.Process]::GetProcessById($ownedId)
    try { return @{present=$true;birth=$owned.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()} }
    finally { $owned.Dispose() }
  } catch [ArgumentException] { return @{present=$false;birth=$null} }
}
[Console]::WriteLine((@{worker=(Observe ${workerPid});helper=(Observe ${helperPid})}|ConvertTo-Json -Compress))
`;
  const result = spawnSync(
    win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(script, 'utf16le').toString('base64'),
    ],
    {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 8192,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  if (result.error || result.status !== 0) throw Error('Owned process observation unavailable');
  const value = JSON.parse(result.stdout);
  for (const entry of [value.worker, value.helper]) {
    if (
      typeof entry?.present !== 'boolean' ||
      (entry.present
        ? typeof entry.birth !== 'string' || !/^\d+$/.test(entry.birth)
        : entry.birth !== null)
    )
      throw Error('Invalid owned process observation');
  }
  return value;
}

export function sameObservedProcess(
  before: OwnedProcessObservation,
  after: OwnedProcessObservation
): boolean {
  return before.present && after.present && before.birth === after.birth;
}
