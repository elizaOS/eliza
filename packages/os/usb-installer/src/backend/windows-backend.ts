import {
  type ChildProcessWithoutNullStreams,
  execFile,
  spawn,
} from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  InvalidDevicePathError,
  InvalidDiskNumberError,
  InvalidImagePathError,
  InvalidScriptPathError,
  PowerShellExecutionError,
  SystemDiskProtectedError,
  UserCancelledElevationError,
  WslDetectedError,
} from "./errors";
import { downloadFile } from "./image-download";
import { sha256File } from "./image-file";
import { withTemporaryImageDirectory } from "./image-workspace";
import { fetchReleaseImages } from "./release-manifest";
import type {
  ElizaOsImage,
  InstallerStep,
  InstallerStepId,
  RemovableDrive,
  UsbInstallerBackend,
  WritePlan,
  WriteRequest,
} from "./types";
import {
  assertDriveMatchesExpected,
  assertWritePlanAllowed,
  assertWriteTargetUnchanged,
} from "./write-safety";

const execFileAsync = promisify(execFile);

const STEP_LABELS: Record<InstallerStepId, string> = {
  "resolve-image": "Resolve image",
  checksum: "Validate checksum",
  write: "Write image",
  verify: "Finalize media",
  complete: "Complete",
};

const PHYSICAL_DRIVE_RE = /^\\\\\.\\PhysicalDrive\d+$/;
// Windows absolute path beginning with a drive letter, e.g. C:\folder\file.iso
const WINDOWS_ABS_PATH_RE = /^[A-Za-z]:\\[^\0]+$/;
const IMAGE_PATH_FORBIDDEN_RE = /[;`&|<>]|\$\(/;
const SCRIPT_NAME_RE = /^elizaos-[\w-]+\.txt$/;
const MAX_DISK_NUMBER = 1000;

/**
 * Quote and escape a string for safe inclusion inside a PowerShell single-quoted
 * string literal. PowerShell escapes a single quote inside a single-quoted
 * literal by doubling it ('').
 */
export function psEscape(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Start-Process flattens ArgumentList; preserve Windows argument boundaries. */
function windowsArgument(value: string): string {
  if (/[\0\r\n]/.test(value))
    throw new Error("Invalid Windows command argument.");
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

export function buildWindowsWriteCommand(
  executable: "diskpart.exe" | "dd.exe" | "powershell.exe",
  args: readonly string[],
  elevated: boolean,
): string {
  if (elevated) {
    return `& ${psEscape(executable)} ${args.map(psEscape).join(" ")}
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
  }
  const commandLine = args.map(windowsArgument).join(" ");
  return `$child = Start-Process -FilePath ${psEscape(executable)} -ArgumentList ${psEscape(commandLine)} -Verb RunAs -Wait -PassThru
if ($null -eq $child.ExitCode) { throw "Elevated writer returned no exit code." }
if ($child.ExitCode -ne 0) { exit $child.ExitCode }`;
}

export function assertValidDiskNumber(diskNumber: number): void {
  if (
    !Number.isInteger(diskNumber) ||
    diskNumber < 0 ||
    diskNumber >= MAX_DISK_NUMBER
  ) {
    throw new InvalidDiskNumberError(
      `Disk number ${String(diskNumber)} is out of range [0, ${MAX_DISK_NUMBER}).`,
      diskNumber,
    );
  }
}

export function assertValidPhysicalDrive(devicePath: string): void {
  if (!PHYSICAL_DRIVE_RE.test(devicePath)) {
    throw new InvalidDevicePathError(
      `Device path ${devicePath} does not match \\\\.\\PhysicalDriveN.`,
      devicePath,
    );
  }
}

export function assertValidImagePath(imagePath: string): void {
  if (
    !WINDOWS_ABS_PATH_RE.test(imagePath) ||
    IMAGE_PATH_FORBIDDEN_RE.test(imagePath)
  ) {
    throw new InvalidImagePathError(
      `Image path ${imagePath} is not a safe absolute Windows path.`,
      imagePath,
    );
  }
}

export function assertValidScriptPath(
  scriptPath: string,
  tmpRoot: string,
): void {
  if (!WINDOWS_ABS_PATH_RE.test(scriptPath)) {
    throw new InvalidScriptPathError(
      `Script path ${scriptPath} is not an absolute Windows path.`,
      scriptPath,
    );
  }
  const normalizedScript = path.win32.normalize(scriptPath).toLowerCase();
  const normalizedTmp = path.win32.normalize(tmpRoot).toLowerCase();
  if (path.win32.dirname(normalizedScript) !== normalizedTmp) {
    throw new InvalidScriptPathError(
      `Script path ${scriptPath} must live under the system temp directory.`,
      scriptPath,
    );
  }
  const base = path.win32.basename(scriptPath);
  if (!SCRIPT_NAME_RE.test(base)) {
    throw new InvalidScriptPathError(
      `Script filename ${base} does not match elizaos-<name>.txt.`,
      scriptPath,
    );
  }
}

export function detectWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
  } catch {
    return false;
  }
}

function wrapPowerShellScript(body: string): string {
  return `$ErrorActionPreference = "Stop"
try {
${body}
} catch {
  Write-Error $_
  exit 1
}`;
}

export function buildElevatedPowerShellCommand(script: string): string {
  const encoded = Buffer.from(wrapPowerShellScript(script), "utf16le").toString(
    "base64",
  );
  return buildWindowsWriteCommand(
    "powershell.exe",
    ["-NonInteractive", "-NoProfile", "-EncodedCommand", encoded],
    false,
  );
}

async function runPowerShell(script: string): Promise<string> {
  const wrapped = wrapPowerShellScript(script);
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NonInteractive",
    "-NoProfile",
    "-Command",
    wrapped,
  ]);
  return stdout;
}

interface PsDiskRaw {
  Number: number;
  FriendlyName: string;
  Size: number;
  BusType: string;
  IsBoot: boolean;
  IsSystem: boolean;
  DriveLetters: string[];
  SystemDrive: string;
  UniqueId?: string;
}

interface ClassifiedDisk {
  number: number;
  friendlyName: string;
  size: number;
  busType: string;
  isBoot: boolean;
  isSystem: boolean;
  driveLetters: string[];
  systemDrive: string;
}

const INTERNAL_HINTS = ["internal", "samsung ssd", "wd_black sn", "nvme"];

export function parseWindowsDiskInventory(output: string): PsDiskRaw[] {
  const invalid = (message: string): never => {
    throw new PowerShellExecutionError(
      `Invalid disk inventory: ${message}`,
      null,
      "",
    );
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return invalid("expected JSON");
  }
  if (!Array.isArray(parsed)) return invalid("expected a disk array");
  const numbers = new Set<number>();
  return parsed.map((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return invalid("expected a disk object");
    const disk = value as Record<string, unknown>;
    if (typeof disk.Number !== "number") return invalid("missing disk number");
    assertValidDiskNumber(disk.Number);
    if (numbers.has(disk.Number)) return invalid("duplicate disk number");
    numbers.add(disk.Number);
    if (
      typeof disk.Size !== "number" ||
      !Number.isSafeInteger(disk.Size) ||
      disk.Size < 0
    )
      return invalid("invalid disk size");
    if (typeof disk.IsBoot !== "boolean" || typeof disk.IsSystem !== "boolean")
      return invalid("missing boot/system flags");
    if (
      typeof disk.FriendlyName !== "string" ||
      typeof disk.BusType !== "string" ||
      !disk.BusType
    )
      return invalid("invalid disk description");
    if (
      typeof disk.SystemDrive !== "string" ||
      !/^[a-z]:$/i.test(disk.SystemDrive)
    )
      return invalid("invalid system drive");
    if (
      !Array.isArray(disk.DriveLetters) ||
      disk.DriveLetters.some(
        (letter: unknown) =>
          typeof letter !== "string" || !/^[a-z]:$/i.test(letter),
      )
    )
      return invalid("invalid drive letters");
    if (disk.UniqueId !== undefined && typeof disk.UniqueId !== "string")
      return invalid("invalid disk identity");
    return disk as unknown as PsDiskRaw;
  });
}

export function classifyDiskSafety(disk: ClassifiedDisk): {
  safety: "safe-removable" | "blocked-system";
  description: string;
} {
  if (disk.busType !== "USB") {
    return {
      safety: "blocked-system",
      description: `Bus type ${disk.busType} is not USB`,
    };
  }
  if (disk.isBoot || disk.isSystem) {
    return {
      safety: "blocked-system",
      description: "Contains system or boot partition",
    };
  }
  const sysDrive = (disk.systemDrive ?? "C:").toUpperCase();
  if (
    disk.driveLetters.some((letter) =>
      letter.toUpperCase().startsWith(sysDrive),
    )
  ) {
    return {
      safety: "blocked-system",
      description: `Contains ${sysDrive} drive`,
    };
  }
  const friendly = (disk.friendlyName ?? "").toLowerCase();
  if (INTERNAL_HINTS.some((hint) => friendly.includes(hint))) {
    return {
      safety: "blocked-system",
      description: `Friendly name suggests internal disk: ${disk.friendlyName}`,
    };
  }
  return {
    safety: "safe-removable",
    description: `USB disk ${disk.number} - ${disk.friendlyName}`,
  };
}

function pendingSteps(): InstallerStep[] {
  return (Object.keys(STEP_LABELS) as InstallerStepId[]).map((id) => ({
    id,
    label: STEP_LABELS[id],
    status: "pending",
    detail: "Waiting to start.",
  }));
}

/**
 * Build a diskpart script that wipes and creates a primary partition on a disk
 * number. The script vocabulary is a closed English set we control, so locale
 * does not affect this output.
 */
export function buildDiskpartScript(diskNumber: number): string {
  assertValidDiskNumber(diskNumber);
  return [
    `select disk ${diskNumber}`,
    "clean",
    "create partition primary",
    "format fs=fat32 quick",
    "assign",
    "exit",
  ].join("\r\n");
}

/**
 * Native PowerShell streaming write fallback when dd.exe is unavailable.
 * Reads `imagePath` and streams it to `physicalDrive` with a 4 MiB buffer.
 * Emits `PROGRESS: <bytesWritten>` lines on stdout so the parent process can
 * track progress.
 */
function buildNativeWriteScript(
  imagePath: string,
  physicalDrive: string,
): string {
  const escImage = psEscape(imagePath);
  const escDrive = psEscape(physicalDrive);
  return `$source = $null
$dest = $null
$failures = [System.Collections.Generic.List[System.Exception]]::new()
try {
  $source = [System.IO.File]::OpenRead(${escImage})
  $dest = [System.IO.File]::Open(${escDrive}, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
  $buffer = New-Object byte[] (4 * 1024 * 1024)
  $total = 0
  while (($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
    $dest.Write($buffer, 0, $read)
    $total += $read
    Write-Host ("PROGRESS: " + $total)
  }
  $dest.Flush($true)
} catch {
  $failures.Add($_.Exception)
} finally {
  foreach ($stream in @($dest, $source)) {
    if ($null -ne $stream) {
      try { $stream.Dispose() } catch { $failures.Add($_.Exception) }
    }
  }
}
if ($failures.Count -gt 0) {
  throw [System.AggregateException]::new("Native disk write failed.", $failures.ToArray())
}`;
}

export function parsePowerShellBoolean(output: string): boolean {
  const value = output.trim();
  if (value === "yes") return true;
  if (value === "no") return false;
  throw new PowerShellExecutionError(
    "PowerShell capability probe returned an invalid response.",
    0,
    output,
  );
}

async function isAlreadyElevated(): Promise<boolean> {
  return parsePowerShellBoolean(
    await runPowerShell(
      `if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { "yes" } else { "no" }`,
    ),
  );
}

async function hasDdExe(): Promise<boolean> {
  return parsePowerShellBoolean(
    await runPowerShell(
      `if (Get-Command dd.exe -ErrorAction SilentlyContinue) { "yes" } else { "no" }`,
    ),
  );
}

function isUacCancellation(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("operation was canceled by the user") ||
    lower.includes("the operation was cancelled by the user")
  );
}

export async function spawnPowerShell(
  script: string,
  onStdout?: (chunk: string) => void,
  spawnChild: (
    command: string,
    args: string[],
  ) => ChildProcessWithoutNullStreams = spawn,
): Promise<void> {
  const wrapped = wrapPowerShellScript(script);
  return new Promise((resolve, reject) => {
    const proc = spawnChild("powershell.exe", [
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      wrapped,
    ]);
    let stderr = "";
    const failures: unknown[] = [];
    let processFailed = false;
    let progressFailed = false;
    proc.stdout.on("data", (chunk: Buffer) => {
      if (!onStdout || progressFailed) return;
      try {
        onStdout(chunk.toString());
      } catch (error) {
        progressFailed = true;
        failures.push(error);
      }
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", (error) => {
      processFailed = true;
      failures.push(error);
    });
    proc.on("close", (code, signal) => {
      if (
        code !== 0 &&
        (!processFailed || (code !== null && code > 0) || signal !== null)
      ) {
        failures.push(
          isUacCancellation(stderr)
            ? new UserCancelledElevationError()
            : new PowerShellExecutionError(
                `PowerShell exited with ${signal ? `signal ${signal}` : `code ${code ?? "?"}`}: ${stderr.trim()}`,
                code,
                stderr,
              ),
        );
      }
      if (failures.length === 1) reject(failures[0]);
      else if (failures.length > 1)
        reject(
          new AggregateError(
            failures,
            "PowerShell writer encountered multiple failures.",
          ),
        );
      else resolve();
    });
  });
}

export class WindowsUsbInstallerBackend implements UsbInstallerBackend {
  constructor() {
    if (detectWsl()) {
      throw new WslDetectedError();
    }
  }

  async listRemovableDrives(): Promise<RemovableDrive[]> {
    // Use Get-Disk + Get-Partition (locale-independent structured output).
    const script = `
$systemDrive = $env:SystemDrive
$disks = Get-Disk
$result = @()
foreach ($d in $disks) {
  $parts = Get-Partition -DiskNumber $d.Number -ErrorAction Stop
  $isBoot = $d.IsBoot
  $isSystem = $d.IsSystem
  $letters = @()
  if ($parts) {
    foreach ($p in $parts) {
      if ($p.IsBoot) { $isBoot = $true }
      if ($p.IsSystem) { $isSystem = $true }
      if ($p.DriveLetter) { $letters += ($p.DriveLetter + ':') }
    }
  }
  $result += [PSCustomObject]@{
    Number = $d.Number
    FriendlyName = $d.FriendlyName
    Size = $d.Size
    BusType = [string]$d.BusType
    IsBoot = $isBoot
    IsSystem = $isSystem
    DriveLetters = $letters
    SystemDrive = $systemDrive
    UniqueId = [string]$d.UniqueId
  }
}
ConvertTo-Json -InputObject @($result) -Depth 4 -Compress
`;
    const output = await runPowerShell(script);
    const rawDisks = parseWindowsDiskInventory(output);

    return rawDisks.map((raw): RemovableDrive => {
      const classified: ClassifiedDisk = {
        number: raw.Number,
        friendlyName: raw.FriendlyName,
        size: raw.Size,
        busType: raw.BusType,
        isBoot: raw.IsBoot,
        isSystem: raw.IsSystem,
        driveLetters: raw.DriveLetters,
        systemDrive: raw.SystemDrive,
      };
      const verdict = classifyDiskSafety(classified);
      const drive: RemovableDrive = {
        id: String(classified.number),
        name: classified.friendlyName || `Disk ${classified.number}`,
        devicePath: `\\\\.\\PhysicalDrive${classified.number}`,
        sizeBytes: classified.size,
        bus: classified.busType === "USB" ? "usb" : "unknown",
        platform: "win32",
        safety: verdict.safety,
        description: verdict.description,
      };
      const uniqueId = raw.UniqueId?.trim();
      if (uniqueId) drive.stableId = `windows:${uniqueId}`;
      return drive;
    });
  }

  async listImages(): Promise<ElizaOsImage[]> {
    return fetchReleaseImages();
  }

  async createWritePlan(request: WriteRequest): Promise<WritePlan> {
    const [drives, images] = await Promise.all([
      this.listRemovableDrives(),
      this.listImages(),
    ]);

    const drive = drives.find((d) => d.id === request.driveId);
    if (!drive) throw new Error(`Unknown drive id: ${request.driveId}`);
    assertDriveMatchesExpected(request, drive);

    const image = images.find((img) => img.id === request.imageId);
    if (!image) throw new Error(`Unknown image id: ${request.imageId}`);

    if (!request.acknowledgeDataLoss) {
      throw new Error(
        "Data-loss acknowledgement is required before preparing media.",
      );
    }

    const blockedReason =
      drive.safety !== "safe-removable"
        ? "the target is not marked safe-removable."
        : drive.sizeBytes < image.minUsbSizeBytes
          ? `the target is ${Math.round(drive.sizeBytes / 1024 ** 3)} GiB but ${Math.round(image.minUsbSizeBytes / 1024 ** 3)} GiB is required.`
          : null;

    const steps: InstallerStep[] = blockedReason
      ? (Object.keys(STEP_LABELS) as InstallerStepId[]).map((id) => ({
          id,
          label: STEP_LABELS[id],
          status: "blocked",
          detail: `Blocked: ${blockedReason}`,
        }))
      : request.dryRun
        ? (Object.keys(STEP_LABELS) as InstallerStepId[]).map((id) => ({
            id,
            label: STEP_LABELS[id],
            status: "complete",
            detail: "Dry-run complete; no bytes were written.",
          }))
        : pendingSteps();

    return {
      request,
      drive,
      image,
      steps,
      privilegedWriteImplemented: true,
    };
  }

  async executeWritePlan(
    plan: WritePlan,
    onProgress: (step: InstallerStepId, progress: number) => void,
  ): Promise<void> {
    plan = structuredClone(plan);
    assertWritePlanAllowed(plan);

    if (plan.drive.safety !== "safe-removable") {
      throw new SystemDiskProtectedError(
        `Drive ${plan.drive.id} is marked ${plan.drive.safety}; write aborted.`,
        Number(plan.drive.id),
      );
    }

    const { image, drive } = plan;
    const diskNumber = Number(drive.id);
    assertValidDiskNumber(diskNumber);
    assertValidPhysicalDrive(drive.devicePath);

    await withTemporaryImageDirectory(async (tmpRoot) => {
      const imagePath = path.join(tmpRoot, `${image.checksumSha256}.iso`);
      const scriptPath = path.join(tmpRoot, "elizaos-diskpart.txt");

      // Step: resolve-image
      onProgress("resolve-image", 0);
      await downloadFile(
        image.url,
        imagePath,
        image.sizeBytes,
        (received, total) => {
          const pct = total > 0 ? received / total : 0;
          onProgress("resolve-image", pct);
        },
      );
      onProgress("resolve-image", 1);

      // Validate every interpolated path before crossing the shell boundary.
      assertValidImagePath(imagePath);
      assertValidScriptPath(scriptPath, tmpRoot);

      // Step: checksum
      onProgress("checksum", 0);
      const actual = await sha256File(imagePath);
      if (actual !== image.checksumSha256) {
        throw new Error(
          `Checksum mismatch: expected ${image.checksumSha256}, got ${actual}`,
        );
      }
      onProgress("checksum", 1);

      // Step: write -- diskpart prepares, then dd.exe or native PS streams.
      onProgress("write", 0);
      const diskpartScript = buildDiskpartScript(diskNumber);
      await fs.writeFile(scriptPath, diskpartScript, "utf8");

      const elevated = await isAlreadyElevated();
      const useDd = await hasDdExe();
      assertWriteTargetUnchanged(plan, await this.listRemovableDrives());

      // Run diskpart (elevated if necessary).
      const diskpartCommand = buildWindowsWriteCommand(
        "diskpart.exe",
        ["/s", scriptPath],
        elevated,
      );
      await spawnPowerShell(diskpartCommand);

      // Capability probes settle before any disk mutation.
      if (useDd) {
        const ddCommand = buildWindowsWriteCommand(
          "dd.exe",
          [`if=${imagePath}`, `of=${drive.devicePath}`, "bs=4M", "--progress"],
          elevated,
        );
        await spawnPowerShell(ddCommand, (chunk) => {
          const match = chunk.match(/(\d+)\s+bytes/);
          if (match?.[1] && image.sizeBytes > 0) {
            onProgress(
              "write",
              Math.min(Number(match[1]) / image.sizeBytes, 0.99),
            );
          }
        });
      } else {
        // Native PowerShell streaming write. Must run elevated to open
        // \\.\PhysicalDriveN for writing.
        const nativeScript = buildNativeWriteScript(
          imagePath,
          drive.devicePath,
        );
        if (elevated) {
          await spawnPowerShell(nativeScript, (chunk) => {
            const m = chunk.match(/PROGRESS:\s+(\d+)/);
            if (m?.[1] && image.sizeBytes > 0) {
              onProgress(
                "write",
                Math.min(Number(m[1]) / image.sizeBytes, 0.99),
              );
            }
          });
        } else {
          await spawnPowerShell(buildElevatedPowerShellCommand(nativeScript));
        }
      }
      onProgress("write", 1);

      // Step: verify
      onProgress("verify", 0);
      await runPowerShell(
        `$disk = Get-Disk -Number ${diskNumber}; $disk | Set-Disk -IsOffline $false`,
      );
      onProgress("verify", 1);
    });
    onProgress("complete", 1);
  }
}
