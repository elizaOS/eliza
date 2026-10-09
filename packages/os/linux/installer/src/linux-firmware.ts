import { lstat, statfs } from "node:fs/promises";
import type { DiskInventory } from "./types";

export class LinuxFirmwareProbeError extends Error {
  readonly code = "ELIZAOS_LINUX_FIRMWARE_PROBE_ERROR";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LinuxFirmwareProbeError";
  }
}

/** Kernel boot evidence only; installed boot files do not identify firmware. */
export async function detectLinuxInstallFirmware(): Promise<
  DiskInventory["firmware"]
> {
  if (process.platform !== "linux") {
    throw new LinuxFirmwareProbeError("Firmware detection requires Linux.");
  }
  try {
    const directory = await lstat("/sys/firmware");
    const filesystem = await statfs("/sys/firmware");
    if (!directory.isDirectory() || filesystem.type !== 0x62656572) {
      throw new LinuxFirmwareProbeError(
        "Firmware evidence must come from the kernel sysfs directory.",
      );
    }
    try {
      const efi = await lstat("/sys/firmware/efi");
      if (!efi.isDirectory()) {
        throw new LinuxFirmwareProbeError(
          "Kernel EFI evidence is not a directory.",
        );
      }
      return "uefi";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return process.arch === "x64" || process.arch === "ia32"
          ? "bios"
          : "unknown";
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof LinuxFirmwareProbeError) throw error;
    throw new LinuxFirmwareProbeError(
      "Kernel firmware evidence is unavailable.",
      {
        cause: error,
      },
    );
  }
}
