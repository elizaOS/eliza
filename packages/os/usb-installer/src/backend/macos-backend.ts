import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import {
  DiskutilPermissionError,
  InvalidDevicePathError,
  InvalidImagePathError,
  UserCancelledAuthError,
} from "./errors";
import { downloadFile } from "./image-download";
import { sha256File } from "./image-file";
import { withTemporaryImageDirectory } from "./image-workspace";
import {
  containsProtectedApplePartition,
  type DiskUtilInfoPlist,
  type DiskUtilListPlist,
  parseDiskutilPlist,
  validateDiskutilInfo,
  validateDiskutilList,
} from "./macos-inventory";
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

// Strict regexes used to gate paths before they hit any subprocess.
// imagePath must be an absolute file under a known macOS prefix; rawDisk must
// be a whole-disk character device like /dev/rdisk3 (NOT /dev/rdisk3s1).
const IMAGE_PATH_RE = /^\/(?:tmp|var|Users|Volumes|private)\/[A-Za-z0-9._/-]+$/;
const RAW_DISK_RE = /^\/dev\/rdisk\d+$/;
const DEVICE_DISK_RE = /^\/dev\/disk(\d+)$/;

// ---------------------------------------------------------------------------
// Shell escaping for osascript / `do shell script` round-tripping.
// ---------------------------------------------------------------------------

// POSIX single-quote escape: 'a'\''b' style. Safe to concatenate.
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// AppleScript-string escape (inside the `"..."` we hand to -e).
// Only backslashes and double-quotes need escaping inside that string literal.
export function appleScriptStringEscape(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// diskutil wrappers
// ---------------------------------------------------------------------------

interface SubprocessError {
  code?: number;
  stderr?: string;
  stdout?: string;
}

function isSubprocessError(err: unknown): err is SubprocessError {
  return (
    typeof err === "object" &&
    err !== null &&
    ("code" in err || "stderr" in err || "stdout" in err)
  );
}

async function getDiskUtilList(): Promise<DiskUtilListPlist> {
  const { stdout } = await execFileAsync("diskutil", ["list", "-plist"]);
  return validateDiskutilList(await parseDiskutilPlist(stdout));
}

async function getDiskUtilInfo(
  deviceIdentifier: string,
): Promise<DiskUtilInfoPlist | null> {
  try {
    const { stdout } = await execFileAsync("diskutil", [
      "info",
      "-plist",
      `/dev/${deviceIdentifier}`,
    ]);
    return validateDiskutilInfo(
      await parseDiskutilPlist(stdout),
      deviceIdentifier,
    );
  } catch (err: unknown) {
    if (isSubprocessError(err)) {
      const stderr = (err.stderr ?? "").toLowerCase();
      if (
        stderr.includes("permission denied") ||
        stderr.includes("operation not permitted")
      ) {
        throw new DiskutilPermissionError(
          `diskutil info denied for /dev/${deviceIdentifier}: ${err.stderr?.trim()}`,
          deviceIdentifier,
        );
      }
      if (stderr.includes("could not find")) {
        return null;
      }
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

async function fileSize(filePath: string): Promise<number> {
  const stat = await fs.stat(filePath);
  return stat.size;
}

function pendingSteps(): InstallerStep[] {
  return (Object.keys(STEP_LABELS) as InstallerStepId[]).map((id) => ({
    id,
    label: STEP_LABELS[id],
    status: "pending",
    detail: "Waiting to start.",
  }));
}

// ---------------------------------------------------------------------------
// Path validation — exported for tests.
// ---------------------------------------------------------------------------

export function validateImagePath(imagePath: string): string {
  if (!IMAGE_PATH_RE.test(imagePath)) {
    throw new InvalidImagePathError(
      `Image path does not match allowed shape: ${imagePath}`,
      imagePath,
    );
  }
  return imagePath;
}

export function deriveRawDisk(devicePath: string): string {
  const m = DEVICE_DISK_RE.exec(devicePath);
  if (!m) {
    throw new InvalidDevicePathError(
      `Device path is not a whole disk (/dev/diskN): ${devicePath}`,
      devicePath,
    );
  }
  const rawDisk = `/dev/rdisk${m[1]}`;
  if (!RAW_DISK_RE.test(rawDisk)) {
    throw new InvalidDevicePathError(
      `Derived raw disk failed validation: ${rawDisk}`,
      rawDisk,
    );
  }
  return rawDisk;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export class MacOsUsbInstallerBackend implements UsbInstallerBackend {
  async listRemovableDrives(): Promise<RemovableDrive[]> {
    const plist = await getDiskUtilList();
    const disks = plist.AllDisksAndPartitions;
    const drives: RemovableDrive[] = [];

    for (const disk of disks) {
      const deviceId = disk.DeviceIdentifier;
      if (!deviceId) continue;

      const info = await getDiskUtilInfo(deviceId);
      if (!info) continue;

      const isInternal =
        info.Internal === true || info.OSInternalMedia === true;
      const isVirtual = info.VirtualOrPhysical === "Virtual";
      const isRemovable =
        info.Removable === true || info.RemovableMediaOrExternalDevice === true;
      const isEjectable = info.Ejectable === true;
      const busProtocol = (info.BusProtocol ?? "").toLowerCase();
      const isUsb = busProtocol === "usb";
      const isDiskImage = busProtocol === "disk image" || isVirtual;

      // USB-NVMe enclosures (e.g. Samsung T7) report BusProtocol=USB and
      // Ejectable=true but may not set Removable=true. They must never have
      // Internal=true — that flag alone blocks the drive regardless of other fields.
      const isExternalUsbEnclosure = isEjectable && !isInternal;

      const content = disk.Content ?? "";
      const isApfsOrHfs = containsProtectedApplePartition(disk);

      let safety: RemovableDrive["safety"] = "unknown";
      if (isInternal) {
        // Internal flag is an absolute block.
        safety = "blocked-system";
      } else if (isApfsOrHfs) {
        // APFS/HFS/CoreStorage partitions are never installer targets.
        safety = "blocked-system";
      } else if (isDiskImage) {
        // Disk images are not real USB drives. Skip entirely.
        continue;
      } else if (isUsb || isRemovable || isExternalUsbEnclosure) {
        safety = "safe-removable";
      }

      const name =
        info.MediaName ?? info.IORegistryEntryName ?? `Disk ${deviceId}`;

      const bus: RemovableDrive["bus"] = isUsb
        ? "usb"
        : busProtocol.includes("sd")
          ? "sd"
          : "unknown";

      const drive: RemovableDrive = {
        id: deviceId,
        name,
        devicePath: `/dev/${deviceId}`,
        sizeBytes: info.TotalSize ?? disk.Size,
        bus,
        platform: "darwin",
        safety,
        description: `${busProtocol || "unknown bus"} - ${content || "no partition table"}`,
      };
      const deviceTreePath = info.DeviceTreePath?.trim();
      if (deviceTreePath) drive.stableId = `darwin:${deviceTreePath}`;
      drives.push(drive);
    }

    return drives;
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

    const { image, drive } = plan;
    await withTemporaryImageDirectory(async (cacheDir) => {
      const imagePath = validateImagePath(
        path.join(cacheDir, `${image.checksumSha256}.iso`),
      );
      const rawDisk = deriveRawDisk(drive.devicePath);

      // Step: resolve-image (download)
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

      // Pre-checksum: verify size matches manifest if known.
      if (image.sizeBytes > 0) {
        const actualSize = await fileSize(imagePath);
        if (actualSize !== image.sizeBytes) {
          // Drop the bad file so the next run will re-download from scratch.
          await fs.rm(imagePath, { force: true });
          throw new Error(
            `Downloaded image size ${actualSize} does not match manifest ${image.sizeBytes}; deleted and aborting.`,
          );
        }
      }

      // Step: checksum
      onProgress("checksum", 0);
      const actual = await sha256File(imagePath);
      if (actual !== image.checksumSha256) {
        await fs.rm(imagePath, { force: true });
        throw new Error(
          `Checksum mismatch: expected ${image.checksumSha256}, got ${actual}`,
        );
      }
      onProgress("checksum", 1);

      assertWriteTargetUnchanged(plan, await this.listRemovableDrives());
      onProgress("write", 0);
      await execFileAsync("diskutil", ["unmountDisk", drive.devicePath]);

      // Build the `dd` invocation with shell-quoted paths so that even though
      // osascript double-evaluates the string, no metacharacter can escape.
      const ddCmd = `dd if=${shellSingleQuote(imagePath)} of=${shellSingleQuote(rawDisk)} bs=1m`;
      const appleScript = `do shell script "${appleScriptStringEscape(ddCmd)}" with administrator privileges`;

      try {
        await execFileAsync("osascript", ["-e", appleScript]);
      } catch (err: unknown) {
        if (isSubprocessError(err)) {
          const stderr = err.stderr ?? "";
          if (/user cancell?ed\./i.test(stderr)) {
            throw new UserCancelledAuthError(
              "Authentication cancelled — click Write to retry.",
            );
          }
        }
        throw err;
      }
      onProgress("write", 1);

      // Step: verify (eject)
      onProgress("verify", 0);
      await execFileAsync("diskutil", ["eject", drive.devicePath]);
      onProgress("verify", 1);
    });
    onProgress("complete", 1);
  }
}
