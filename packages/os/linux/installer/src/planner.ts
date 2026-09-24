import { createHash } from "node:crypto";
import type {
  DiskInventory,
  FreeExtent,
  InstallerAction,
  InstallPlan,
  InstallRequest,
  PartitionInventory,
  PlannedPartition,
} from "./types";

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const ALIGNMENT = MIB;
const ESP_BYTES = GIB;
const RECOVERY_BYTES = 8 * GIB;
const ROOT_BYTES = 48 * GIB;
const MIN_STATE_BYTES = 16 * GIB;
const MIN_INSTALL_BYTES =
  ESP_BYTES + RECOVERY_BYTES + ROOT_BYTES + MIN_STATE_BYTES;
const MIN_REUSABLE_ESP_BYTES = 512 * MIB;
const PARTITION_TABLES = new Set(["gpt", "mbr", "none", "unknown"]);
const FIRMWARE_MODES = new Set([
  "uefi",
  "apple-intel-efi",
  "apple-silicon",
  "bios",
  "unknown",
]);
const PARTITION_ROLES = new Set(["esp", "os", "recovery", "data", "unknown"]);
const FILESYSTEMS = new Set([
  "fat32",
  "ntfs",
  "apfs",
  "ext4",
  "btrfs",
  "xfs",
  "swap",
  "unknown",
]);
const OS_FAMILIES = new Set(["windows", "macos", "linux", "unknown"]);
const ENCRYPTION_STATES = new Set([
  "none",
  "bitlocker",
  "filevault",
  "luks",
  "unknown",
]);
const FILESYSTEM_HEALTH_STATES = new Set([
  "healthy",
  "dirty",
  "unhealthy",
  "unknown",
]);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function alignUp(value: number): number {
  return Math.ceil(value / ALIGNMENT) * ALIGNMENT;
}

function alignDown(value: number): number {
  return Math.floor(value / ALIGNMENT) * ALIGNMENT;
}

function extentSize(extent: { startBytes: number; endBytes: number }): number {
  return extent.endBytes - extent.startBytes;
}

function assertSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer.`);
  }
}

export function validateDiskInventory(disk: DiskInventory): void {
  if (!disk.stableId.trim() || !disk.path.trim())
    throw new Error("Disk stableId and path are required.");
  if (
    disk.kernelDeviceIdentity !== undefined &&
    !disk.kernelDeviceIdentity.trim()
  ) {
    throw new Error("Kernel device identity must be non-empty when present.");
  }
  if (
    (!disk.hardwareIdentity.serial.trim() &&
      !disk.hardwareIdentity.wwn?.trim()) ||
    !disk.hardwareIdentity.firmwarePath.trim() ||
    (disk.hardwareIdentity.wwn !== undefined &&
      !disk.hardwareIdentity.wwn.trim()) ||
    (disk.hardwareIdentity.gptDiskGuid !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        disk.hardwareIdentity.gptDiskGuid,
      ))
  ) {
    throw new Error(
      "Disk durable WWN/serial, firmware path, and optional GPT GUID must be exact hardware identity values.",
    );
  }
  assertSafeInteger("disk.sizeBytes", disk.sizeBytes);
  if (disk.sizeBytes < MIN_INSTALL_BYTES)
    throw new Error(
      `Disk is too small; at least ${MIN_INSTALL_BYTES} bytes are required.`,
    );
  if (![512, 4096].includes(disk.logicalSectorBytes))
    throw new Error("Unsupported logical sector size.");
  if (!PARTITION_TABLES.has(disk.partitionTable))
    throw new Error("Unsupported partition-table inventory value.");
  if (
    disk.partitionTable === "gpt" &&
    disk.hardwareIdentity.gptDiskGuid === undefined
  ) {
    throw new Error("GPT inventory must include the disk GUID.");
  }
  if (
    disk.partitionTable !== "gpt" &&
    disk.hardwareIdentity.gptDiskGuid !== undefined
  ) {
    throw new Error("Only GPT inventory may include a GPT disk GUID.");
  }
  if (
    (disk.partitionTable === "gpt" &&
      typeof disk.gptRedundancyVerified !== "boolean") ||
    (disk.partitionTable !== "gpt" && disk.gptRedundancyVerified !== undefined)
  ) {
    throw new Error(
      "GPT inventory must explicitly report redundant main/backup verification.",
    );
  }
  if (!FIRMWARE_MODES.has(disk.firmware))
    throw new Error("Unsupported firmware inventory value.");
  if (typeof disk.bootAncestryResolved !== "boolean")
    throw new Error("Boot ancestry inventory must be explicit.");
  if (typeof disk.currentBootSource !== "boolean")
    throw new Error("Current boot-source inventory must be explicit.");

  for (const partition of disk.partitions) {
    if (!PARTITION_ROLES.has(partition.role))
      throw new Error(`Partition ${partition.id} has an invalid role.`);
    if (!FILESYSTEMS.has(partition.filesystem))
      throw new Error(`Partition ${partition.id} has an invalid filesystem.`);
    if (
      partition.filesystemHealth !== undefined &&
      !FILESYSTEM_HEALTH_STATES.has(partition.filesystemHealth)
    ) {
      throw new Error(
        `Partition ${partition.id} has invalid filesystem health evidence.`,
      );
    }
    if (typeof partition.mounted !== "boolean")
      throw new Error(
        `Partition ${partition.id} mount state must be explicit.`,
      );
    if (
      (partition.hibernated !== undefined &&
        typeof partition.hibernated !== "boolean") ||
      (partition.dirty !== undefined && typeof partition.dirty !== "boolean")
    ) {
      throw new Error(
        `Partition ${partition.id} has invalid hibernation or dirty-state evidence.`,
      );
    }
    if (
      partition.hibernated !== undefined &&
      (partition.filesystem !== "ntfs" || partition.osFamily !== "windows")
    ) {
      throw new Error(
        `Partition ${partition.id} has hibernation evidence outside Windows NTFS.`,
      );
    }
    if (partition.osFamily && !OS_FAMILIES.has(partition.osFamily))
      throw new Error(`Partition ${partition.id} has an invalid OS family.`);
    if (partition.encryption && !ENCRYPTION_STATES.has(partition.encryption))
      throw new Error(
        `Partition ${partition.id} has invalid encryption state.`,
      );
    if (partition.resize) {
      assertSafeInteger(
        `${partition.id}.resize.minimumBytes`,
        partition.resize.minimumBytes,
      );
      if (
        partition.resize.minimumBytes <= 0 ||
        partition.resize.minimumBytes >= extentSize(partition) ||
        (partition.resize.bitlocker !== undefined &&
          !["off", "suspended", "enabled"].includes(partition.resize.bitlocker))
      ) {
        throw new Error(
          `Partition ${partition.id} has invalid resize minimum or BitLocker evidence.`,
        );
      }
      if (
        typeof partition.resize.filesystemHealthy !== "boolean" ||
        typeof partition.resize.mounted !== "boolean" ||
        partition.resize.mounted !== partition.mounted ||
        (partition.filesystemHealth !== undefined &&
          partition.filesystemHealth !== "healthy") ||
        (partition.hibernated !== undefined &&
          partition.resize.hibernated !== partition.hibernated) ||
        (partition.dirty !== undefined &&
          partition.resize.dirty !== partition.dirty) ||
        (partition.resize.hibernated !== undefined &&
          typeof partition.resize.hibernated !== "boolean") ||
        (partition.resize.dirty !== undefined &&
          typeof partition.resize.dirty !== "boolean")
      ) {
        throw new Error(
          `Partition ${partition.id} has invalid resize evidence.`,
        );
      }
    }
  }

  const ranges = [
    ...disk.partitions.map((item) => ({ ...item, kind: "partition" as const })),
    ...disk.freeExtents.map((item) => ({
      ...item,
      kind: "free extent" as const,
    })),
  ].sort((a, b) => a.startBytes - b.startBytes || a.endBytes - b.endBytes);
  const ids = new Set<string>();
  let previousEnd = 0;
  for (const range of ranges) {
    if (!range.id.trim() || ids.has(range.id))
      throw new Error(
        `Duplicate or empty disk range id: ${range.id || "<empty>"}.`,
      );
    ids.add(range.id);
    assertSafeInteger(`${range.id}.startBytes`, range.startBytes);
    assertSafeInteger(`${range.id}.endBytes`, range.endBytes);
    if (
      range.startBytes < ALIGNMENT ||
      range.endBytes <= range.startBytes ||
      range.endBytes > disk.sizeBytes
    ) {
      throw new Error(`Invalid ${range.kind} bounds for ${range.id}.`);
    }
    if (range.startBytes < previousEnd)
      throw new Error(`Overlapping disk ranges at ${range.id}.`);
    previousEnd = range.endBytes;
  }
}

export function createDiskInventoryFingerprint(disk: DiskInventory): string {
  const partitions = [...disk.partitions]
    .sort(
      (left, right) =>
        left.startBytes - right.startBytes || left.id.localeCompare(right.id),
    )
    .map((partition) => ({
      id: partition.id,
      startBytes: partition.startBytes,
      endBytes: partition.endBytes,
      mounted: partition.mounted,
      role: partition.role,
      filesystem: partition.filesystem,
      filesystemHealth: partition.filesystemHealth ?? null,
      hibernated: partition.hibernated ?? null,
      dirty: partition.dirty ?? null,
      osFamily: partition.osFamily ?? null,
      encryption: partition.encryption ?? null,
      resize: partition.resize
        ? {
            filesystemHealthy: partition.resize.filesystemHealthy,
            mounted: partition.resize.mounted,
            minimumBytes: partition.resize.minimumBytes,
            bitlocker: partition.resize.bitlocker ?? null,
            hibernated: partition.resize.hibernated ?? null,
            dirty: partition.resize.dirty ?? null,
          }
        : null,
    }));
  const freeExtents = [...disk.freeExtents]
    .sort(
      (left, right) =>
        left.startBytes - right.startBytes || left.id.localeCompare(right.id),
    )
    .map((extent) => ({
      id: extent.id,
      startBytes: extent.startBytes,
      endBytes: extent.endBytes,
    }));
  return sha256(
    JSON.stringify({
      schemaVersion: 1,
      stableId: disk.stableId,
      path: disk.path,
      kernelDeviceIdentity: disk.kernelDeviceIdentity ?? null,
      hardwareIdentity: {
        serial: disk.hardwareIdentity.serial,
        wwn: disk.hardwareIdentity.wwn ?? null,
        firmwarePath: disk.hardwareIdentity.firmwarePath,
        gptDiskGuid: disk.hardwareIdentity.gptDiskGuid ?? null,
      },
      sizeBytes: disk.sizeBytes,
      logicalSectorBytes: disk.logicalSectorBytes,
      partitionTable: disk.partitionTable,
      gptRedundancyVerified: disk.gptRedundancyVerified ?? null,
      bootAncestryResolved: disk.bootAncestryResolved,
      currentBootSource: disk.currentBootSource,
      firmware: disk.firmware,
      protectedReason: disk.protectedReason ?? null,
      partitions,
      freeExtents,
    }),
  );
}

export function createDiskConfirmationToken(disk: DiskInventory): string {
  return sha256(`elizaos-install-v2\n${createDiskInventoryFingerprint(disk)}`);
}

/**
 * Alias-independent physical identity used for cross-plan serialization.
 * Mutable partition-table state and caller-selected by-id/path spellings are
 * deliberately excluded. Kernel generation remains a separate, plan-bound
 * value so an interrupted lock survives device re-enumeration and reboot.
 */
export function createDiskExecutionIdentity(disk: DiskInventory): string {
  validateDiskInventory(disk);
  const serial = disk.hardwareIdentity.serial.trim().toLowerCase();
  if (!serial) {
    throw new Error(
      "Privileged disk execution requires a durable serial hardware identity.",
    );
  }
  return sha256(
    JSON.stringify({
      schemaVersion: 2,
      durableIdentity: { kind: "serial", value: serial },
    }),
  );
}

function assertTarget(request: InstallRequest, disk: DiskInventory): void {
  validateDiskInventory(disk);
  if (disk.currentBootSource)
    throw new Error(
      "Refusing to install onto the disk that booted the installer.",
    );
  if (!disk.bootAncestryResolved) {
    throw new Error(
      "Refusing to install because current boot-device ancestry is unresolved.",
    );
  }
  if (disk.partitions.some((partition) => partition.mounted)) {
    throw new Error(
      "Refusing to install while a target partition or stacked descendant is mounted.",
    );
  }
  if (disk.partitionTable === "gpt" && disk.gptRedundancyVerified !== true) {
    throw new Error(
      "Refusing to install because GPT main/backup redundancy is unverified.",
    );
  }
  if (disk.protectedReason)
    throw new Error(`Target disk is protected: ${disk.protectedReason}`);
  if (
    request.mode === "alongside" &&
    disk.partitions.some(
      (partition) =>
        partition.osFamily === "windows" &&
        (partition.filesystem !== "ntfs" || partition.hibernated !== false),
    )
  ) {
    throw new Error(
      "Refusing alongside installation without explicit evidence that Windows hibernation and Fast Startup are disabled.",
    );
  }
  if (
    request.mode === "alongside" &&
    disk.partitions.some((partition) => partition.dirty === true)
  ) {
    throw new Error(
      "Refusing alongside installation while an existing filesystem is dirty.",
    );
  }
  if (
    request.targetStableId !== disk.stableId ||
    request.expectedSizeBytes !== disk.sizeBytes
  ) {
    throw new Error("Target disk identity changed after review.");
  }
  if (request.confirmationToken !== createDiskConfirmationToken(disk)) {
    throw new Error("Target disk confirmation token is missing or stale.");
  }
  if (disk.firmware === "apple-silicon") {
    throw new Error(
      "Apple Silicon installation requires an Asahi/m1n1 boot-chain integration and is not supported by the generic Debian installer.",
    );
  }
}

function reusableEsp(disk: DiskInventory): PartitionInventory | undefined {
  return disk.partitions.find(
    (part) =>
      part.role === "esp" &&
      part.filesystem === "fat32" &&
      extentSize(part) >= MIN_REUSABLE_ESP_BYTES,
  );
}

function assertShrinkEligible(partition: PartitionInventory): void {
  const evidence = partition.resize;
  if (!evidence?.filesystemHealthy || partition.mounted || evidence.mounted) {
    throw new Error(
      `Partition ${partition.id} lacks healthy, unmounted resize evidence.`,
    );
  }
  if (evidence.dirty)
    throw new Error(
      `Partition ${partition.id} is dirty and must be repaired in its existing OS.`,
    );
  if (partition.encryption && partition.encryption !== "none") {
    throw new Error(
      `Encrypted ${partition.encryption} partition ${partition.id} cannot be shrunk automatically.`,
    );
  }
  if (partition.osFamily === "macos" || partition.filesystem === "apfs") {
    throw new Error(
      "Automatic APFS shrinking is not supported; create unallocated space with macOS Disk Utility first.",
    );
  }
  if (partition.osFamily === "windows") {
    if (
      partition.filesystem !== "ntfs" ||
      evidence.hibernated !== false ||
      (evidence.bitlocker !== "off" && evidence.bitlocker !== "suspended")
    ) {
      throw new Error(
        "Windows shrinking requires healthy NTFS, hibernation off, and BitLocker off or suspended.",
      );
    }
  } else if (
    !(["ext4", "btrfs"] as const).includes(
      partition.filesystem as "ext4" | "btrfs",
    )
  ) {
    throw new Error(
      `Filesystem ${partition.filesystem} does not have a supported shrink path.`,
    );
  }
  if (
    evidence.minimumBytes <= 0 ||
    evidence.minimumBytes >= extentSize(partition)
  ) {
    throw new Error(
      `Partition ${partition.id} has invalid minimum-size evidence.`,
    );
  }
}

function allocatePartitions(
  extent: FreeExtent,
  existingEsp?: PartitionInventory,
): PlannedPartition[] {
  const start = alignUp(extent.startBytes);
  const end = alignDown(extent.endBytes);
  const required =
    RECOVERY_BYTES +
    ROOT_BYTES +
    MIN_STATE_BYTES +
    (existingEsp ? 0 : ESP_BYTES);
  if (end - start < required)
    throw new Error(
      `Selected free space is too small; ${required} aligned bytes are required.`,
    );

  const partitions: PlannedPartition[] = [];
  let cursor = start;
  if (existingEsp) {
    partitions.push({
      role: "esp",
      startBytes: existingEsp.startBytes,
      endBytes: existingEsp.endBytes,
      filesystem: "fat32",
      reusePartitionId: existingEsp.id,
    });
  } else {
    partitions.push({
      role: "esp",
      startBytes: cursor,
      endBytes: cursor + ESP_BYTES,
      filesystem: "fat32",
    });
    cursor += ESP_BYTES;
  }
  partitions.push({
    role: "recovery",
    startBytes: cursor,
    endBytes: cursor + RECOVERY_BYTES,
    filesystem: "ext4",
  });
  cursor += RECOVERY_BYTES;
  partitions.push({
    role: "root",
    startBytes: cursor,
    endBytes: cursor + ROOT_BYTES,
    filesystem: "ext4",
  });
  cursor += ROOT_BYTES;
  partitions.push({
    role: "state",
    startBytes: cursor,
    endBytes: end,
    filesystem: "ext4",
  });
  return partitions;
}

function planBody(
  request: InstallRequest,
  disk: DiskInventory,
): Omit<InstallPlan, "planId"> {
  assertTarget(request, disk);
  if (request.mode === "erase-disk") {
    if (request.freeExtentId || request.shrinkPartitionId)
      throw new Error(
        "Erase-disk mode cannot select free space or a shrink source.",
      );
    const extent = {
      id: "whole-disk",
      startBytes: ALIGNMENT,
      endBytes: alignDown(disk.sizeBytes - ALIGNMENT),
    };
    const partitions = allocatePartitions(extent);
    const root = partitions.find((partition) => partition.role === "root");
    if (!root)
      throw new Error(
        "Internal planner error: root partition allocation failed.",
      );
    const actions: InstallerAction[] = [
      {
        type: "erase-partition-table",
        diskStableId: disk.stableId,
        destructive: true,
      },
      ...partitions.map(
        (partition): InstallerAction => ({
          type: "create-partition",
          partition,
          destructive: true,
        }),
      ),
      {
        type: "install-system",
        rootStartBytes: root.startBytes,
        rootEndBytes: root.endBytes,
        destructive: true,
      },
      { type: "install-bootloader", destructive: true },
    ];
    return {
      schemaVersion: 1,
      mode: request.mode,
      target: {
        stableId: disk.stableId,
        path: disk.path,
        hardwareIdentity: { ...disk.hardwareIdentity },
        sizeBytes: disk.sizeBytes,
        logicalSectorBytes: disk.logicalSectorBytes,
        gptRedundancyVerified: disk.gptRedundancyVerified,
        bootAncestryResolved: disk.bootAncestryResolved,
      },
      preservedPartitionIds: [],
      partitions,
      actions,
      warnings: [
        "All existing partitions and data on the target disk will be destroyed.",
      ],
      compatibility: {
        firmware: disk.firmware,
        automaticShrinkSupported: false,
        preparationRequiredInExistingOs: false,
      },
      executable: false,
    };
  }

  if (disk.partitionTable !== "gpt")
    throw new Error(
      "Alongside installation requires an existing GPT partition table.",
    );
  if (!["uefi", "apple-intel-efi"].includes(disk.firmware)) {
    throw new Error(
      `Alongside installation does not support firmware mode ${disk.firmware}.`,
    );
  }
  if (Boolean(request.freeExtentId) === Boolean(request.shrinkPartitionId)) {
    throw new Error(
      "Alongside installation requires exactly one free extent or shrink partition selection.",
    );
  }
  const esp = reusableEsp(disk);
  let extent: FreeExtent;
  const leadingActions: InstallerAction[] = [];
  const warnings = [
    "Existing operating-system partitions are preserved but partition changes always carry data-loss risk.",
  ];
  if (request.freeExtentId) {
    const selected = disk.freeExtents.find(
      (item) => item.id === request.freeExtentId,
    );
    if (!selected)
      throw new Error(`Unknown free extent: ${request.freeExtentId}`);
    extent = selected;
  } else {
    const selected = disk.partitions.find(
      (item) => item.id === request.shrinkPartitionId,
    );
    if (!selected)
      throw new Error(`Unknown shrink partition: ${request.shrinkPartitionId}`);
    assertShrinkEligible(selected);
    const required =
      RECOVERY_BYTES + ROOT_BYTES + MIN_STATE_BYTES + (esp ? 0 : ESP_BYTES);
    const newEnd = alignDown(selected.endBytes - required);
    if (
      newEnd <
      selected.startBytes +
        (selected.resize?.minimumBytes ?? Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error(
        `Partition ${selected.id} cannot release enough verified free space.`,
      );
    }
    leadingActions.push({
      type: "shrink-partition",
      partitionId: selected.id,
      newEndBytes: newEnd,
      destructive: true,
    });
    extent = {
      id: `after-${selected.id}`,
      startBytes: newEnd,
      endBytes: selected.endBytes,
    };
    warnings.push(
      `Partition ${selected.id} must be revalidated immediately before shrinking.`,
    );
  }
  const partitions = allocatePartitions(extent, esp);
  const root = partitions.find((item) => item.role === "root");
  if (!root)
    throw new Error(
      "Internal planner error: root partition allocation failed.",
    );
  const actions: InstallerAction[] = [
    ...leadingActions,
    ...(esp
      ? [
          {
            type: "reuse-esp",
            partitionId: esp.id,
            destructive: false,
          } as const,
        ]
      : []),
    ...partitions
      .filter((item) => !item.reusePartitionId)
      .map(
        (partition): InstallerAction => ({
          type: "create-partition",
          partition,
          destructive: true,
        }),
      ),
    {
      type: "install-system",
      rootStartBytes: root.startBytes,
      rootEndBytes: root.endBytes,
      destructive: true,
    },
    {
      type: "install-bootloader",
      ...(esp ? { espPartitionId: esp.id } : {}),
      destructive: true,
    },
  ];
  return {
    schemaVersion: 1,
    mode: request.mode,
    target: {
      stableId: disk.stableId,
      path: disk.path,
      ...(disk.kernelDeviceIdentity
        ? { kernelDeviceIdentity: disk.kernelDeviceIdentity }
        : {}),
      hardwareIdentity: { ...disk.hardwareIdentity },
      sizeBytes: disk.sizeBytes,
      logicalSectorBytes: disk.logicalSectorBytes,
      gptRedundancyVerified: disk.gptRedundancyVerified,
      bootAncestryResolved: disk.bootAncestryResolved,
    },
    preservedPartitionIds: disk.partitions.map((item) => item.id).sort(),
    partitions,
    actions,
    warnings,
    compatibility: {
      firmware: disk.firmware,
      automaticShrinkSupported: Boolean(request.shrinkPartitionId),
      preparationRequiredInExistingOs:
        disk.firmware === "apple-intel-efi" ||
        disk.partitions.some(
          (part) =>
            part.filesystem === "apfs" || part.encryption === "filevault",
        ),
    },
    executable: false,
  };
}

export function createInstallPlan(
  request: InstallRequest,
  disk: DiskInventory,
): InstallPlan {
  const body = planBody(request, disk);
  return { ...body, planId: sha256(JSON.stringify(body)) };
}

export const INSTALLER_MINIMUMS = {
  alignmentBytes: ALIGNMENT,
  minimumInstallBytes: MIN_INSTALL_BYTES,
  reusableEspBytes: MIN_REUSABLE_ESP_BYTES,
} as const;
