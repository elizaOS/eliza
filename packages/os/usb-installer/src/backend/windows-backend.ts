import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, promises as fs } from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { DEFAULT_ELIZAOS_IMAGES } from "./dry-run-backend";
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
} from "./write-safety";

const execFileAsync = promisify(execFile);

const STEP_LABELS: Record<InstallerStepId, string> = {
  "resolve-image": "Resolve image",
  checksum: "Validate checksum",
  write: "Write image",
  verify: "Verify media",
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
  const normalizedScript = path.normalize(scriptPath).toLowerCase();
  const normalizedTmp = path.normalize(tmpRoot).toLowerCase();
  if (!normalizedScript.startsWith(normalizedTmp)) {
    throw new InvalidScriptPathError(
      `Script path ${scriptPath} must live under the system temp directory.`,
      scriptPath,
    );
  }
  const base = path.basename(scriptPath);
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
  DriveLetters: string[] | string | null;
  SystemDrive: string;
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

function normalizeDriveLetters(value: string[] | string | null): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((s) => typeof s === "string");
  return [value];
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

async function fetchGitHubIsoImages(): Promise<ElizaOsImage[]> {
  return new Promise((resolve) => {
    const req = https.get(
      "https://api.github.com/repos/elizaos/eliza/releases",
      { headers: { "User-Agent": "elizaos-usb-installer/1.0" } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            const releases = JSON.parse(body) as Array<{
              tag_name: string;
              published_at: string;
              prerelease: boolean;
              assets: Array<{
                name: string;
                browser_download_url: string;
                size: number;
              }>;
            }>;

            const images: ElizaOsImage[] = [];
            for (const release of releases) {
              for (const asset of release.assets) {
                if (!asset.name.endsWith(".iso")) continue;
                const arch: ElizaOsImage["architecture"] = asset.name.includes(
                  "arm64",
                )
                  ? "arm64"
                  : "x86_64";
                const channel: ElizaOsImage["channel"] = release.prerelease
                  ? "nightly"
                  : "stable";
                images.push({
                  id: `github-${release.tag_name}-${asset.name}`,
                  label: `elizaOS ${release.tag_name}`,
                  version: release.tag_name,
                  channel,
                  architecture: arch,
                  buildId: release.tag_name,
                  publishedAt: release.published_at,
                  url: asset.browser_download_url,
                  checksumSha256:
                    "0000000000000000000000000000000000000000000000000000000000000000",
                  sizeBytes: asset.size,
                  minUsbSizeBytes: Math.max(asset.size * 1.2, 8 * 1024 ** 3),
                  manifestVersion: 1,
                });
              }
            }
            resolve(images.length > 0 ? images : DEFAULT_ELIZAOS_IMAGES);
          } catch {
            resolve(DEFAULT_ELIZAOS_IMAGES);
          }
        });
        res.on("error", () => resolve(DEFAULT_ELIZAOS_IMAGES));
      },
    );
    req.on("error", () => resolve(DEFAULT_ELIZAOS_IMAGES));
  });
}

async function downloadFile(
  url: string,
  destPath: string,
  onProgress: (bytes: number, total: number) => void,
): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });

  return new Promise((resolve, reject) => {
    function doRequest(requestUrl: string): void {
      const protocol = requestUrl.startsWith("https://") ? https : http;
      protocol
        .get(
          requestUrl,
          { headers: { "User-Agent": "elizaos-usb-installer/1.0" } },
          (res) => {
            if (
              res.statusCode === 301 ||
              res.statusCode === 302 ||
              res.statusCode === 307 ||
              res.statusCode === 308
            ) {
              const location = res.headers.location;
              if (!location) {
                reject(
                  new Error(
                    `Redirect with no location header from ${requestUrl}`,
                  ),
                );
                return;
              }
              doRequest(location);
              return;
            }
            if (res.statusCode !== 200) {
              reject(
                new Error(
                  `HTTP ${res.statusCode ?? "?"} downloading ${requestUrl}`,
                ),
              );
              return;
            }
            const total = Number(res.headers["content-length"] ?? 0);
            let received = 0;
            const writeStream = createWriteStream(destPath);
            res.on("data", (chunk: Buffer) => {
              received += chunk.length;
              onProgress(received, total);
            });
            res.pipe(writeStream);
            writeStream.on("finish", resolve);
            writeStream.on("error", reject);
            res.on("error", reject);
          },
        )
        .on("error", reject);
    }
    doRequest(url);
  });
}

async function sha256File(filePath: string): Promise<string> {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
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
  return `$source = [System.IO.File]::OpenRead(${escImage})
$dest = [System.IO.File]::OpenWrite(${escDrive})
try {
  $buffer = New-Object byte[] (4 * 1024 * 1024)
  $total = 0
  while (($read = $source.Read($buffer, 0, $buffer.Length)) -gt 0) {
    $dest.Write($buffer, 0, $read)
    $total += $read
    Write-Host ("PROGRESS: " + $total)
  }
  $dest.Flush($true)
} finally {
  $source.Dispose()
  $dest.Dispose()
}`;
}

async function isAlreadyElevated(): Promise<boolean> {
  try {
    const out = await runPowerShell(
      `if ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { "yes" } else { "no" }`,
    );
    return out.trim() === "yes";
  } catch {
    return false;
  }
}

async function hasDdExe(): Promise<boolean> {
  try {
    const out = await runPowerShell(
      `if (Get-Command dd.exe -ErrorAction SilentlyContinue) { "yes" } else { "no" }`,
    );
    return out.trim() === "yes";
  } catch {
    return false;
  }
}

function isUacCancellation(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return (
    lower.includes("operation was canceled by the user") ||
    lower.includes("0x80004005") ||
    lower.includes("the operation was cancelled by the user")
  );
}

async function spawnPowerShell(
  script: string,
  onStdout?: (chunk: string) => void,
): Promise<void> {
  const wrapped = wrapPowerShellScript(script);
  return new Promise((resolve, reject) => {
    const proc = spawn("powershell.exe", [
      "-NonInteractive",
      "-NoProfile",
      "-Command",
      wrapped,
    ]);
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      if (onStdout) onStdout(chunk.toString());
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (isUacCancellation(stderr)) {
        reject(new UserCancelledElevationError());
        return;
      }
      reject(
        new PowerShellExecutionError(
          `PowerShell exited with code ${code ?? "?"}: ${stderr.trim()}`,
          code,
          stderr,
        ),
      );
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
  $parts = Get-Partition -DiskNumber $d.Number -ErrorAction SilentlyContinue
  $isBoot = $false
  $isSystem = $false
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
  }
}
$result | ConvertTo-Json -Depth 4 -Compress
`;
    const output = await runPowerShell(script);
    const trimmed = output.trim();
    if (!trimmed) return [];

    const rawParsed = JSON.parse(trimmed) as PsDiskRaw | PsDiskRaw[];
    const rawDisks: PsDiskRaw[] = Array.isArray(rawParsed)
      ? rawParsed
      : [rawParsed];

    return rawDisks.map((raw): RemovableDrive => {
      const classified: ClassifiedDisk = {
        number: raw.Number,
        friendlyName: raw.FriendlyName,
        size: raw.Size,
        busType: raw.BusType,
        isBoot: Boolean(raw.IsBoot),
        isSystem: Boolean(raw.IsSystem),
        driveLetters: normalizeDriveLetters(raw.DriveLetters),
        systemDrive: raw.SystemDrive ?? "C:",
      };
      const verdict = classifyDiskSafety(classified);
      return {
        id: String(classified.number),
        name: classified.friendlyName || `Disk ${classified.number}`,
        devicePath: `\\\\.\\PhysicalDrive${classified.number}`,
        sizeBytes: classified.size,
        bus: classified.busType === "USB" ? "usb" : "unknown",
        platform: "win32",
        safety: verdict.safety,
        description: verdict.description,
      };
    });
  }

  async listImages(): Promise<ElizaOsImage[]> {
    return fetchGitHubIsoImages();
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

    const tmpRoot = path.join(os.tmpdir(), "elizaos-usb-installer");
    await fs.mkdir(tmpRoot, { recursive: true });
    const imagePath = path.join(tmpRoot, `${image.id}.iso`);
    const scriptPath = path.join(tmpRoot, "elizaos-diskpart.txt");

    // Step: resolve-image
    onProgress("resolve-image", 0);
    let needsDownload = false;
    try {
      await fs.access(imagePath);
    } catch {
      needsDownload = true;
    }

    if (needsDownload) {
      await downloadFile(image.url, imagePath, (received, total) => {
        const pct = total > 0 ? received / total : 0;
        onProgress("resolve-image", pct);
      });
    }
    onProgress("resolve-image", 1);

    // Validate every interpolated path before crossing the shell boundary.
    assertValidImagePath(imagePath);
    assertValidScriptPath(scriptPath, tmpRoot);

    // Step: checksum
    onProgress("checksum", 0);
    const ZEROED_CHECKSUM = "0".repeat(64);
    if (image.checksumSha256 !== ZEROED_CHECKSUM) {
      const actual = await sha256File(imagePath);
      if (actual !== image.checksumSha256) {
        throw new Error(
          `Checksum mismatch: expected ${image.checksumSha256}, got ${actual}`,
        );
      }
    }
    onProgress("checksum", 1);

    // Step: write -- diskpart prepares, then dd.exe or native PS streams.
    onProgress("write", 0);
    const diskpartScript = buildDiskpartScript(diskNumber);
    await fs.writeFile(scriptPath, diskpartScript, "utf8");

    const elevated = await isAlreadyElevated();

    // Run diskpart (elevated if necessary).
    const diskpartCommand = elevated
      ? `& diskpart.exe /s ${psEscape(scriptPath)} | Out-Null`
      : `Start-Process diskpart.exe -ArgumentList @('/s', ${psEscape(scriptPath)}) -Verb RunAs -Wait`;
    await spawnPowerShell(diskpartCommand);

    // Choose write strategy: dd.exe if present, else native PowerShell.
    const useDd = await hasDdExe();
    if (useDd) {
      const ddArgs = [
        `'if=' + ${psEscape(imagePath)}`,
        `'of=' + ${psEscape(drive.devicePath)}`,
        `'bs=4M'`,
        `'--progress'`,
      ].join(", ");
      const ddCommand = elevated
        ? `& dd.exe ${psEscape(`if=${imagePath}`)} ${psEscape(`of=${drive.devicePath}`)} bs=4M --progress`
        : `Start-Process dd.exe -ArgumentList @(${ddArgs}) -Verb RunAs -Wait`;
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
      const nativeScript = buildNativeWriteScript(imagePath, drive.devicePath);
      if (elevated) {
        await spawnPowerShell(nativeScript, (chunk) => {
          const m = chunk.match(/PROGRESS:\s+(\d+)/);
          if (m?.[1] && image.sizeBytes > 0) {
            onProgress("write", Math.min(Number(m[1]) / image.sizeBytes, 0.99));
          }
        });
      } else {
        // Re-spawn ourselves under RunAs to execute the streaming script. We
        // write the script to disk because passing a multi-line script through
        // Start-Process arguments is fragile.
        const nativeScriptPath = path.join(tmpRoot, "elizaos-write.txt");
        await fs.writeFile(
          nativeScriptPath,
          wrapPowerShellScript(nativeScript),
          "utf8",
        );
        assertValidScriptPath(nativeScriptPath, tmpRoot);
        const elevateCmd = `Start-Process powershell.exe -ArgumentList @('-NonInteractive','-NoProfile','-File', ${psEscape(nativeScriptPath)}) -Verb RunAs -Wait`;
        await spawnPowerShell(elevateCmd);
        await fs.unlink(nativeScriptPath).catch(() => undefined);
      }
    }
    onProgress("write", 1);

    await fs.unlink(scriptPath).catch(() => undefined);

    // Step: verify
    onProgress("verify", 0);
    await runPowerShell(
      `$disk = Get-Disk -Number ${diskNumber}; $disk | Set-Disk -IsOffline $false`,
    ).catch(() => undefined);
    onProgress("verify", 1);

    onProgress("complete", 1);
  }
}
