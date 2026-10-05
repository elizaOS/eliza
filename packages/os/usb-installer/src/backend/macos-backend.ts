import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DiskutilPermissionError } from "./errors";
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
  RemovableDrive,
  UsbInstallerBackend,
  WritePlan,
  WriteRequest,
} from "./types";
import { createPlatformWritePlan } from "./write-plan";

const execFileAsync = promisify(execFile);

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
    return createPlatformWritePlan(this, request);
  }
}
