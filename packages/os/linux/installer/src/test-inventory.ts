/** In-memory disk mutations for execution/service tests. No device I/O. */
import type { DiskInventory, InstallerAction } from "./types";

export function applyTestInventoryAction(
  target: DiskInventory,
  action: InstallerAction,
): void {
  switch (action.type) {
    case "erase-partition-table":
      target.partitions = [];
      target.partitionTable = "gpt";
      target.gptRedundancyVerified = true;
      target.hardwareIdentity.gptDiskGuid =
        "11111111-2222-4333-8444-555555555555";
      break;
    case "create-partition":
      target.partitions.push({
        id: `created-${action.partition.startBytes}`,
        startBytes: action.partition.startBytes,
        endBytes: action.partition.endBytes,
        role:
          action.partition.role === "esp"
            ? "esp"
            : action.partition.role === "recovery"
              ? "recovery"
              : "data",
        filesystem: action.partition.filesystem,
        filesystemHealth: "healthy",
        encryption: "none",
        mounted: false,
      });
      break;
    case "shrink-partition": {
      const source = target.partitions.find(
        (item) => item.id === action.partitionId,
      );
      if (!source) throw new Error("Missing shrink fixture.");
      source.endBytes = action.newEndBytes;
      break;
    }
    case "reuse-esp":
    case "install-system":
    case "install-bootloader":
      break;
  }
  let cursor = 1024 ** 2;
  target.freeExtents = [];
  for (const partition of [...target.partitions].sort(
    (a, b) => a.startBytes - b.startBytes,
  )) {
    if (cursor < partition.startBytes) {
      target.freeExtents.push({
        id: `free-${cursor}`,
        startBytes: cursor,
        endBytes: partition.startBytes,
      });
    }
    cursor = partition.endBytes;
  }
  const end = target.sizeBytes - 1024 ** 2;
  if (cursor < end)
    target.freeExtents.push({
      id: `free-${cursor}`,
      startBytes: cursor,
      endBytes: end,
    });
}

export function createTestDiskInventory(): DiskInventory {
  return {
    stableId: "serial-TEST-TARGET",
    path: "/dev/sdb",
    kernelDeviceIdentity: "8:16:42",
    hardwareIdentity: {
      serial: "TEST-TARGET",
      firmwarePath: "/sys/devices/test/target",
      gptDiskGuid: "11111111-2222-4333-8444-555555555555",
    },
    sizeBytes: 256 * 1024 ** 3,
    logicalSectorBytes: 512,
    partitionTable: "gpt",
    gptRedundancyVerified: true,
    bootAncestryResolved: true,
    currentBootSource: false,
    firmware: "uefi",
    partitions: [],
    freeExtents: [
      {
        id: "free",
        startBytes: 1024 ** 2,
        endBytes: 256 * 1024 ** 3 - 1024 ** 2,
      },
    ],
  };
}
