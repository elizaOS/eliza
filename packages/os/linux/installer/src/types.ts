export type OsFamily = "windows" | "macos" | "linux" | "unknown";
export type Filesystem =
  | "fat32"
  | "ntfs"
  | "apfs"
  | "ext4"
  | "btrfs"
  | "xfs"
  | "swap"
  | "unknown";

export interface ResizeEvidence {
  filesystemHealthy: boolean;
  mounted: boolean;
  minimumBytes: number;
  bitlocker?: "off" | "suspended" | "enabled";
  hibernated?: boolean;
  dirty?: boolean;
}

export interface PartitionInventory {
  id: string;
  startBytes: number;
  endBytes: number;
  mounted: boolean;
  role: "esp" | "os" | "recovery" | "data" | "unknown";
  filesystem: Filesystem;
  filesystemHealth?: "healthy" | "dirty" | "unhealthy" | "unknown";
  hibernated?: boolean;
  dirty?: boolean;
  osFamily?: OsFamily;
  resize?: ResizeEvidence;
  encryption?: "none" | "bitlocker" | "filevault" | "luks" | "unknown";
}

export interface FreeExtent {
  id: string;
  startBytes: number;
  endBytes: number;
}

export interface DiskHardwareIdentity {
  serial: string;
  wwn?: string;
  firmwarePath: string;
  gptDiskGuid?: string;
}

export interface DiskInventory {
  stableId: string;
  path: string;
  /**
   * Provider-owned identity for this kernel device incarnation. Linux uses
   * block-device rdev plus diskseq. A reviewed plan carries this value, but it
   * is trusted only after reproduction from a fresh provider inventory.
   */
  kernelDeviceIdentity?: string;
  hardwareIdentity: DiskHardwareIdentity;
  sizeBytes: number;
  logicalSectorBytes: number;
  partitionTable: "gpt" | "mbr" | "none" | "unknown";
  gptRedundancyVerified?: boolean;
  bootAncestryResolved: boolean;
  currentBootSource: boolean;
  firmware: "uefi" | "apple-intel-efi" | "apple-silicon" | "bios" | "unknown";
  protectedReason?: string;
  partitions: PartitionInventory[];
  freeExtents: FreeExtent[];
}

export interface InstallRequest {
  mode: "erase-disk" | "alongside";
  targetStableId: string;
  expectedSizeBytes: number;
  confirmationToken: string;
  freeExtentId?: string;
  shrinkPartitionId?: string;
}

export interface PlannedPartition {
  role: "esp" | "recovery" | "root" | "state";
  startBytes: number;
  endBytes: number;
  filesystem: "fat32" | "ext4";
  reusePartitionId?: string;
}

export type InstallerAction =
  | { type: "erase-partition-table"; diskStableId: string; destructive: true }
  | {
      type: "shrink-partition";
      partitionId: string;
      newEndBytes: number;
      destructive: true;
    }
  | { type: "create-partition"; partition: PlannedPartition; destructive: true }
  | { type: "reuse-esp"; partitionId: string; destructive: false }
  | {
      type: "install-system";
      rootStartBytes: number;
      rootEndBytes: number;
      destructive: true;
    }
  | { type: "install-bootloader"; espPartitionId?: string; destructive: true };

export interface InstallPlan {
  schemaVersion: 1;
  planId: string;
  mode: InstallRequest["mode"];
  target: {
    stableId: string;
    path: string;
    kernelDeviceIdentity?: string;
    hardwareIdentity: DiskHardwareIdentity;
    sizeBytes: number;
    logicalSectorBytes: number;
    gptRedundancyVerified?: boolean;
    bootAncestryResolved: boolean;
  };
  preservedPartitionIds: string[];
  partitions: PlannedPartition[];
  actions: InstallerAction[];
  warnings: string[];
  compatibility: {
    firmware: DiskInventory["firmware"];
    automaticShrinkSupported: boolean;
    preparationRequiredInExistingOs: boolean;
  };
  executable: false;
}

export interface InstallAuthorization {
  planId: string;
  inventoryFingerprint: string;
  ownerId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  credential: string;
}

export interface AuthorizedInstallPlan extends Omit<InstallPlan, "executable"> {
  executable: true;
  authorization: InstallAuthorization;
}

export interface PartitionTableBackup {
  stableId: string;
  storageStableId: string;
  location: string;
  sha256: string;
}

export interface InstallerActionReceipt {
  receiptId: string;
  actionDigest: string;
}

export type InstallJournalEvent =
  | "authorized"
  | "partition-table-backup-verified"
  | "action-started"
  | "action-completed"
  | "execution-completed"
  | "execution-failed";

export interface InstallJournalEntry {
  schemaVersion: 1;
  planId: string;
  sequence: number;
  event: InstallJournalEvent;
  timestamp: string;
  inventoryFingerprint: string;
  actionIndex?: number;
  actionDigest?: string;
  receiptId?: string;
  /** Exact recovery artifact, only on the verified backup checkpoint. */
  partitionTableBackup?: PartitionTableBackup;
  previousDigest: string | null;
  digest: string;
}
