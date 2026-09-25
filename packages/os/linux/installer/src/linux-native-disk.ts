import { createHash } from "node:crypto";
import { isAbsolute, join, normalize } from "node:path";
import type { PrivilegedInstallOperations } from "./executor";
import type { FilesystemImageArtifact } from "./filesystem-image";
import { loadLinuxInstallerNativeBinding } from "./linux-native-binding";
import {
  createDiskInventoryFingerprint,
  validateDiskInventory,
} from "./planner";
import type {
  AuthorizedInstallPlan,
  DiskInventory,
  InstallerAction,
  PartitionTableBackup,
} from "./types";

export interface NativeLinuxDiskSession {
  check(): void;
  backup(binding: Buffer): Buffer;
  verify(binding: Buffer, digest: Buffer): void;
  editGpt(
    binding: Buffer,
    originalDigest: Buffer,
    currentDigest: Buffer,
    edit: Buffer,
  ): Buffer;
  writeImage(
    binding: Buffer,
    originalDigest: Buffer,
    currentDigest: Buffer,
    request: Buffer,
  ): Promise<Buffer>;
  cancelImageWrite(): void;
  close(): void;
}

export interface LinuxDiskSessionNativeBinding {
  openDiskSession(
    targetPath: string,
    targetIdentity: Buffer,
    storagePath: string,
    storageIdentity: Buffer,
    storagePartitionPath: string,
    directoryPath: string,
  ): NativeLinuxDiskSession;
}

export interface GptEditReceipt {
  sha256: string;
  bytesWritten: number;
  partitionIndex: number;
  partitionCount: number;
}

type GptAction = Extract<
  InstallerAction,
  { type: "erase-partition-table" | "create-partition" }
>;

type DiskIdentity = Pick<
  DiskInventory,
  | "stableId"
  | "path"
  | "kernelDeviceIdentity"
  | "hardwareIdentity"
  | "sizeBytes"
  | "logicalSectorBytes"
>;

export interface LinuxRecoveryStorage {
  /** Service-configured, independently qualified durable media; never IPC data.
   * Inventory must exclude physical aliases and multipath/stacked devices. */
  disk: DiskIdentity;
  partitionPath: string;
  directoryPath: string;
}

export class LinuxInstallDiskError extends Error {
  readonly code = "ELIZAOS_INSTALL_DISK_ERROR";
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LinuxInstallDiskError";
  }
}

function fail(message: string): never {
  throw new LinuxInstallDiskError(message);
}

function text(value: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4096 ||
    value.includes("\0")
  ) {
    fail("Installer disk identity contains an invalid string.");
  }
  return value;
}

function devicePath(value: string): string {
  if (!/^\/dev\/[a-zA-Z0-9._-]+$/.test(text(value))) {
    fail("Native disk sessions require a canonical /dev device path.");
  }
  return value;
}

function kernelIdentity(disk: DiskIdentity): Buffer {
  devicePath(disk.path);
  text(disk.stableId);
  text(disk.hardwareIdentity.serial);
  text(disk.hardwareIdentity.firmwarePath);
  if (disk.hardwareIdentity.wwn !== undefined) text(disk.hardwareIdentity.wwn);
  const match = /^(0|[1-9]\d*):(0|[1-9]\d*):([1-9]\d*)$/.exec(
    disk.kernelDeviceIdentity ?? "",
  );
  if (
    !match ||
    match[1].length > 10 ||
    match[2].length > 10 ||
    match[3].length > 20
  ) {
    fail("Native disk sessions require an exact major:minor:diskseq identity.");
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const sequence = BigInt(match[3]);
  if (
    major > 0xffffffff ||
    minor > 0xffffffff ||
    sequence > 0xffffffffffffffffn ||
    !Number.isSafeInteger(disk.sizeBytes) ||
    disk.sizeBytes < 64 * 1024 ** 2 ||
    ![512, 4096].includes(disk.logicalSectorBytes) ||
    disk.sizeBytes % disk.logicalSectorBytes !== 0
  ) {
    fail("Native disk geometry or kernel identity is unsupported.");
  }
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(major, 0);
  bytes.writeUInt32LE(minor, 4);
  bytes.writeBigUInt64LE(sequence, 8);
  bytes.writeBigUInt64LE(BigInt(disk.sizeBytes), 16);
  bytes.writeUInt32LE(disk.logicalSectorBytes, 24);
  return bytes;
}

function immutableIdentity(disk: DiskIdentity): string {
  return JSON.stringify({
    stableId: disk.stableId,
    kernelIdentity: kernelIdentity(disk).toString("hex"),
    serial: disk.hardwareIdentity.serial.trim().toLowerCase(),
    wwn: disk.hardwareIdentity.wwn?.trim().toLowerCase() ?? null,
    firmwarePath: disk.hardwareIdentity.firmwarePath,
  });
}

/** Validate declared identities before opening storage; the native session must
 * still qualify and retain the actual device descriptors before preparation. */
export function validateRecoveryStorageIdentity(
  target: DiskIdentity,
  storage: LinuxRecoveryStorage,
): {
  targetBytes: Buffer;
  storageBytes: Buffer;
} {
  const targetBytes = kernelIdentity(target);
  const storageBytes = kernelIdentity(storage.disk);
  const canonical = (value: string | undefined) => value?.trim().toLowerCase();
  if (
    target.stableId === storage.disk.stableId ||
    targetBytes.subarray(0, 8).equals(storageBytes.subarray(0, 8)) ||
    canonical(target.hardwareIdentity.serial) ===
      canonical(storage.disk.hardwareIdentity.serial) ||
    (target.hardwareIdentity.wwn !== undefined &&
      canonical(target.hardwareIdentity.wwn) ===
        canonical(storage.disk.hardwareIdentity.wwn)) ||
    target.hardwareIdentity.firmwarePath ===
      storage.disk.hardwareIdentity.firmwarePath
  ) {
    fail(
      "Recovery storage must be physically independent of the installation target.",
    );
  }
  devicePath(storage.partitionPath);
  text(storage.directoryPath);
  if (
    !isAbsolute(storage.directoryPath) ||
    normalize(storage.directoryPath) !== storage.directoryPath ||
    storage.directoryPath === "/"
  ) {
    fail("Recovery storage requires an exact absolute directory path.");
  }
  return { targetBytes, storageBytes };
}

/** Retained disk component of an installation operations session. The owning service
 * must retain its authenticated physical-target lock until close settles.
 * GPT receipts cover partition metadata only. Filesystem creation, payloads and
 * bootloader writes must finish before a full installer action receipt is issued. */
export class NativeLinuxInstallDiskSession
  implements
    Pick<
      PrivilegedInstallOperations,
      "backupPartitionTable" | "verifyPartitionTableBackup"
    >
{
  readonly #session: NativeLinuxDiskSession;
  readonly #targetIdentity: string;
  readonly #initialFingerprint: string;
  readonly #binding: Buffer;
  readonly #storage: LinuxRecoveryStorage;
  #closed = false;
  #mutationFailed = false;
  #imageActive = false;
  readonly #expiresAt: number;
  readonly #createdPartitions = new Map<
    string,
    { index: number; filesystem: "fat32" | "ext4"; sizeBytes: number }
  >();
  #currentDigest: Buffer | undefined;
  #originalSha256: string | undefined;
  readonly #tableActions: GptAction[];
  #nextTableAction = 0;

  constructor(
    plan: AuthorizedInstallPlan,
    inventory: DiskInventory,
    storage: LinuxRecoveryStorage,
    native: LinuxDiskSessionNativeBinding = loadLinuxInstallerNativeBinding() as LinuxDiskSessionNativeBinding,
  ) {
    validateDiskInventory(inventory);
    if (
      inventory.currentBootSource ||
      !inventory.bootAncestryResolved ||
      inventory.protectedReason ||
      inventory.partitions.some((partition) => partition.mounted) ||
      inventory.partitionTable !== "gpt" ||
      inventory.gptRedundancyVerified !== true
    ) {
      fail(
        "Native backup requires an unmounted, unprotected target with verified GPT.",
      );
    }
    this.#initialFingerprint = createDiskInventoryFingerprint(inventory);
    if (
      plan.executable !== true ||
      !/^[a-f0-9]{64}$/.test(plan.planId) ||
      plan.authorization.planId !== plan.planId ||
      plan.target.stableId !== inventory.stableId ||
      plan.authorization.inventoryFingerprint !== this.#initialFingerprint
    ) {
      fail("Native backup is not bound to the authorized original inventory.");
    }
    this.#expiresAt = Date.parse(plan.authorization.expiresAt);
    if (!Number.isSafeInteger(this.#expiresAt) || this.#expiresAt <= 0)
      fail("Invalid partition image authorization deadline.");
    this.#tableActions = structuredClone(
      plan.actions.filter(
        (action): action is GptAction =>
          action.type === "erase-partition-table" ||
          action.type === "create-partition",
      ),
    );
    this.#storage = structuredClone(storage);
    const saved = this.#storage;
    const { targetBytes, storageBytes } = validateRecoveryStorageIdentity(
      inventory,
      saved,
    );
    this.#targetIdentity = immutableIdentity(inventory);
    this.#binding = createHash("sha256")
      .update(
        JSON.stringify({
          domain: "elizaos-install-gpt-backup-v1",
          planId: plan.planId,
          inventoryFingerprint: this.#initialFingerprint,
          target: this.#targetIdentity,
          storage: immutableIdentity(saved.disk),
          partitionPath: saved.partitionPath,
          directoryPath: saved.directoryPath,
        }),
      )
      .digest();
    this.#session = native.openDiskSession(
      inventory.path,
      targetBytes,
      saved.disk.path,
      storageBytes,
      saved.partitionPath,
      saved.directoryPath,
    );
  }

  #check(inventory: DiskInventory, allowImage = false): void {
    if (this.#imageActive && !allowImage)
      fail("Partition image operation is still running.");
    if (this.#closed) fail("Native partition-table backup session is closed.");
    if (immutableIdentity(inventory) !== this.#targetIdentity) {
      fail("Native backup target identity changed.");
    }
    this.#session.check();
  }

  async backupPartitionTable(
    inventory: DiskInventory,
  ): Promise<PartitionTableBackup> {
    this.#check(inventory);
    if (this.#mutationFailed || this.#nextTableAction !== 0) {
      fail("The original backup cannot be recaptured after a mutation.");
    }
    if (
      createDiskInventoryFingerprint(inventory) !== this.#initialFingerprint
    ) {
      fail("Partition layout changed before its original backup was captured.");
    }
    if (this.#originalSha256 !== undefined)
      fail("The original backup was already captured or adopted.");
    const digest = this.#session.backup(Buffer.from(this.#binding));
    if (!Buffer.isBuffer(digest) || digest.length !== 32) {
      fail("Native backup returned an invalid durable artifact digest.");
    }
    this.#check(inventory);
    this.#currentDigest = Buffer.from(digest);
    const sha256 = digest.toString("hex");
    this.#originalSha256 = sha256;
    return {
      stableId: inventory.stableId,
      storageStableId: this.#storage.disk.stableId,
      location: join(this.#storage.directoryPath, `${sha256}.gpt`),
      sha256,
    };
  }

  #verifyBackup(backup: PartitionTableBackup, inventory: DiskInventory): void {
    this.#check(inventory);
    if (
      Object.keys(backup).length !== 4 ||
      typeof backup.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(backup.sha256) ||
      backup.stableId !== inventory.stableId ||
      backup.storageStableId !== this.#storage.disk.stableId ||
      (this.#originalSha256 !== undefined &&
        backup.sha256 !== this.#originalSha256) ||
      backup.location !==
        join(this.#storage.directoryPath, `${backup.sha256}.gpt`)
    ) {
      fail(
        "Partition-table backup receipt does not match its retained storage binding.",
      );
    }
    this.#session.verify(
      Buffer.from(this.#binding),
      Buffer.from(backup.sha256, "hex"),
    );
    this.#check(inventory);
    this.#originalSha256 ??= backup.sha256;
    this.#currentDigest ??= Buffer.from(backup.sha256, "hex");
  }

  async verifyPartitionTableBackup(
    backup: PartitionTableBackup,
    inventory: DiskInventory,
  ): Promise<boolean> {
    this.#verifyBackup(backup, inventory);
    return true;
  }

  async applyGptEdit(
    action: GptAction,
    inventory: DiskInventory,
    backup: PartitionTableBackup,
  ): Promise<GptEditReceipt> {
    this.#check(inventory);
    if (this.#mutationFailed)
      fail("Disk session requires explicit recovery after a failed mutation.");
    if (!this.#currentDigest)
      fail("Capture the original durable backup before editing the GPT.");
    if (
      JSON.stringify(action) !==
      JSON.stringify(this.#tableActions[this.#nextTableAction])
    ) {
      fail(
        "GPT edit is not the next partition operation in the reviewed plan.",
      );
    }
    this.#verifyBackup(backup, inventory);
    const encoded = Buffer.alloc(24);
    encoded.writeUInt32LE(action.type === "erase-partition-table" ? 1 : 2, 0);
    if (action.type === "create-partition") {
      const roles = { esp: 1, recovery: 2, root: 3, state: 4 };
      encoded.writeUInt32LE(roles[action.partition.role], 4);
      encoded.writeBigUInt64LE(BigInt(action.partition.startBytes), 8);
      encoded.writeBigUInt64LE(BigInt(action.partition.endBytes), 16);
    }
    try {
      const receipt = this.#session.editGpt(
        Buffer.from(this.#binding),
        Buffer.from(backup.sha256, "hex"),
        Buffer.from(this.#currentDigest),
        encoded,
      );
      if (!Buffer.isBuffer(receipt) || receipt.length !== 48)
        fail("Invalid native GPT mutation receipt.");
      const bytesWritten = Number(receipt.readBigUInt64LE(32));
      const partitionIndex = receipt.readUInt32LE(40);
      const partitionCount = receipt.readUInt32LE(44);
      if (
        !Number.isSafeInteger(bytesWritten) ||
        bytesWritten <= 0 ||
        partitionCount > 4096 ||
        (action.type === "erase-partition-table"
          ? partitionIndex !== 0 || partitionCount !== 0
          : partitionIndex < 1 || partitionIndex > 4096 || partitionCount < 1)
      ) {
        fail("Native GPT mutation did not return verified metadata effects.");
      }
      this.#check(inventory);
      this.#currentDigest = Buffer.from(receipt.subarray(0, 32));
      this.#nextTableAction++;
      if (action.type === "create-partition") {
        this.#createdPartitions.set(
          `${action.partition.startBytes}:${action.partition.endBytes}`,
          {
            index: partitionIndex,
            filesystem: action.partition.filesystem,
            sizeBytes: action.partition.endBytes - action.partition.startBytes,
          },
        );
      }
      return {
        sha256: this.#currentDigest.toString("hex"),
        bytesWritten,
        partitionIndex,
        partitionCount,
      };
    } catch (error) {
      this.#mutationFailed = true;
      throw error;
    }
  }

  /** Copy a prepared image only to a partition created by this reviewed session.
   * The caller prepares/health-checks that image on the configured recovery disk.
   * This receipt proves exact bytes and readback, not a complete OS installation. */
  async writePartitionImage(
    extent: { startBytes: number; endBytes: number },
    image: FilesystemImageArtifact,
    inventory: DiskInventory,
    backup: PartitionTableBackup,
    signal?: AbortSignal,
  ): Promise<{ sha256: string; bytesWritten: number; partitionIndex: number }> {
    signal?.throwIfAborted();
    this.#check(inventory);
    if (this.#mutationFailed)
      fail("Disk session requires explicit recovery after a failed mutation.");
    const partition = this.#createdPartitions.get(
      `${extent.startBytes}:${extent.endBytes}`,
    );
    if (
      !partition ||
      !this.#currentDigest ||
      image.filesystem !== partition.filesystem ||
      image.sizeBytes !== partition.sizeBytes ||
      image.storageStableId !== this.#storage.disk.stableId ||
      !/^[a-f0-9]{64}$/.test(image.sha256)
    ) {
      fail(
        "Filesystem image is not bound to a partition created by this reviewed session.",
      );
    }
    this.#verifyBackup(backup, inventory);
    const request = Buffer.alloc(56);
    request.writeUInt32LE(partition.index, 0);
    request.writeBigUInt64LE(BigInt(image.sizeBytes), 8);
    request.writeBigUInt64LE(BigInt(this.#expiresAt), 16);
    Buffer.from(image.sha256, "hex").copy(request, 24);
    const expectedSha = image.sha256;
    const expectedSize = image.sizeBytes;
    const abort = () => this.#session.cancelImageWrite();
    this.#imageActive = true;
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const receipt = await this.#session.writeImage(
        Buffer.from(this.#binding),
        Buffer.from(backup.sha256, "hex"),
        Buffer.from(this.#currentDigest),
        request,
      );
      if (
        !Buffer.isBuffer(receipt) ||
        receipt.length !== 40 ||
        receipt.subarray(0, 32).toString("hex") !== expectedSha ||
        receipt.readBigUInt64LE(32) !== BigInt(expectedSize)
      ) {
        fail(
          "Native partition image receipt does not prove the exact expected write/readback.",
        );
      }
      this.#check(inventory, true);
      signal?.throwIfAborted();
      return {
        sha256: expectedSha,
        bytesWritten: expectedSize,
        partitionIndex: partition.index,
      };
    } catch (error) {
      this.#mutationFailed = true;
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.#imageActive = false;
    }
  }

  async close(): Promise<void> {
    if (this.#imageActive)
      fail(
        "Wait for the partition image operation to settle before closing its session.",
      );
    if (this.#closed) return;
    this.#closed = true;
    this.#session.close();
  }
}
