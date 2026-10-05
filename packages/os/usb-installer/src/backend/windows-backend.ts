import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import {
  InvalidDiskNumberError,
  PowerShellExecutionError,
  WslDetectedError,
} from "./errors";
import { fetchReleaseImages } from "./release-manifest";
import type {
  ElizaOsImage,
  RemovableDrive,
  UsbInstallerBackend,
  WritePlan,
  WriteRequest,
} from "./types";
import { createPlatformWritePlan } from "./write-plan";

const execFileAsync = promisify(execFile);

const MAX_DISK_NUMBER = 1000;

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
    return createPlatformWritePlan(this, request);
  }
}
