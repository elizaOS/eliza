import { describe, expect, it, vi } from "vitest";
import { authorizeInstallPlan } from "./executor";
import {
  type LinuxDiskSessionNativeBinding,
  type LinuxRecoveryStorage,
  NativeLinuxInstallDiskSession,
} from "./linux-native-disk";
import {
  createDiskConfirmationToken,
  createDiskInventoryFingerprint,
  createInstallPlan,
} from "./planner";
import { createTestDiskInventory } from "./test-inventory";

async function fixture() {
  const target = createTestDiskInventory();
  const request = {
    mode: "erase-disk" as const,
    targetStableId: target.stableId,
    expectedSizeBytes: target.sizeBytes,
    confirmationToken: createDiskConfirmationToken(target),
  };
  const reviewed = createInstallPlan(request, target);
  const plan = await authorizeInstallPlan(
    request,
    reviewed,
    {
      planId: reviewed.planId,
      inventoryFingerprint: createDiskInventoryFingerprint(target),
      ownerId: "local-owner-1000",
      issuedAt: "2026-09-24T00:00:00.000Z",
      expiresAt: "2026-09-24T00:10:00.000Z",
      nonce: "native-backup-test",
      credential: "test-owner-approval",
    },
    {
      inventory: { inspect: async () => structuredClone(target) },
      authorization: { verify: async () => true },
      now: () => new Date("2026-09-24T00:05:00.000Z"),
    },
  );
  const storage: LinuxRecoveryStorage = {
    disk: {
      ...structuredClone(target),
      stableId: "separate-storage",
      path: "/dev/sdc",
      kernelDeviceIdentity: "8:32:57",
      sizeBytes: 1024 ** 3,
      hardwareIdentity: {
        serial: "TEST-STORAGE",
        firmwarePath: "/sys/devices/test/storage",
      },
    },
    partitionPath: "/dev/sdc1",
    directoryPath: "/recovery/backups",
  };
  const session = {
    check: vi.fn(),
    backup: vi.fn((_binding: Buffer) => Buffer.alloc(32, 0xaa)),
    verify: vi.fn((_binding: Buffer, _digest: Buffer) => {}),
    editGpt: vi.fn(
      (
        _binding: Buffer,
        _original: Buffer,
        _current: Buffer,
        _edit: Buffer,
      ): Buffer => Buffer.alloc(48),
    ),
    writeImage: vi.fn(
      async (
        _binding: Buffer,
        _original: Buffer,
        _current: Buffer,
        _request: Buffer,
      ): Promise<Buffer> => Buffer.alloc(40),
    ),
    cancelImageWrite: vi.fn(),
    close: vi.fn(),
  };
  const native: LinuxDiskSessionNativeBinding = {
    openDiskSession: vi.fn(() => session),
  };
  const open = () =>
    new NativeLinuxInstallDiskSession(plan, target, storage, native);
  return { target, plan, storage, session, native, open };
}

describe("native partition-table backup adapter", () => {
  it("encodes exact kernel identities and returns the native artifact receipt", async () => {
    const f = await fixture();
    const backup = f.open();
    const args = vi.mocked(f.native.openDiskSession).mock.calls[0];
    expect(args[1].readUInt32LE(0)).toBe(8);
    expect(args[1].readUInt32LE(4)).toBe(16);
    expect(args[1].readBigUInt64LE(8)).toBe(42n);
    expect(args[1].readBigUInt64LE(16)).toBe(BigInt(f.target.sizeBytes));
    expect(args[1].readUInt32LE(24)).toBe(512);
    expect(args[1].readUInt32LE(28)).toBe(0);
    expect(args[3].readBigUInt64LE(16)).toBe(1024n ** 3n);
    const receipt = await backup.backupPartitionTable(f.target);
    expect(receipt).toEqual({
      stableId: f.target.stableId,
      storageStableId: "separate-storage",
      location: `/recovery/backups/${"aa".repeat(32)}.gpt`,
      sha256: "aa".repeat(32),
    });
    await expect(
      backup.verifyPartitionTableBackup(receipt, f.target),
    ).resolves.toBe(true);
    expect(f.session.verify).toHaveBeenCalledWith(
      f.session.backup.mock.calls[0][0],
      Buffer.alloc(32, 0xaa),
    );
  });

  it("retains the original binding when the caller mutates configuration or the target GPT changes", async () => {
    const f = await fixture();
    const backup = f.open();
    f.storage.directoryPath = "/different";
    f.storage.disk.stableId = "different";
    const receipt = await backup.backupPartitionTable(f.target);
    f.target.hardwareIdentity.gptDiskGuid =
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await expect(
      backup.verifyPartitionTableBackup(receipt, f.target),
    ).resolves.toBe(true);
    await expect(backup.backupPartitionTable(f.target)).rejects.toThrow(
      /layout changed/,
    );
  });

  it("rejects receipts for other storage or locations before native verification", async () => {
    const f = await fixture();
    const backup = f.open();
    const receipt = await backup.backupPartitionTable(f.target);
    for (const patch of [
      { storageStableId: "other" },
      { location: "/recovery/../elsewhere" },
      { sha256: "../bad" },
      { stableId: "other" },
      { extra: true },
    ]) {
      await expect(
        backup.verifyPartitionTableBackup({ ...receipt, ...patch }, f.target),
      ).rejects.toThrow(/receipt/);
    }
    expect(f.session.verify).not.toHaveBeenCalled();
  });

  it("rejects changed physical identity or disk incarnation even after a valid backup", async () => {
    const f = await fixture();
    const backup = f.open();
    const receipt = await backup.backupPartitionTable(f.target);
    f.target.kernelDeviceIdentity = "8:16:43";
    await expect(
      backup.verifyPartitionTableBackup(receipt, f.target),
    ).rejects.toThrow(/identity changed/);
    expect(f.session.verify).not.toHaveBeenCalled();
  });

  it.each(["stableId", "kernel", "serial", "wwn", "firmware"])(
    "rejects recovery media aliasing by %s before opening",
    async (kind) => {
      const f = await fixture();
      if (kind === "stableId") f.storage.disk.stableId = f.target.stableId;
      if (kind === "kernel") f.storage.disk.kernelDeviceIdentity = "8:16:58";
      if (kind === "serial")
        f.storage.disk.hardwareIdentity.serial = "test-target";
      if (kind === "wwn") {
        f.target.hardwareIdentity.wwn = "SAME-WWN";
        f.plan.authorization.inventoryFingerprint =
          createDiskInventoryFingerprint(f.target);
        f.storage.disk.hardwareIdentity.wwn = "same-wwn";
      }
      if (kind === "firmware")
        f.storage.disk.hardwareIdentity.firmwarePath =
          f.target.hardwareIdentity.firmwarePath;
      expect(f.open).toThrow(/physically independent/);
      expect(f.native.openDiskSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    "8:16:0",
    "08:16:42",
    "8:16:18446744073709551616",
    "4294967296:16:42",
    "8:16:42:512",
  ])("rejects malformed kernel identity %s", async (identity) => {
    const f = await fixture();
    f.storage.disk.kernelDeviceIdentity = identity;
    expect(f.open).toThrow(/identity|geometry/);
    expect(f.native.openDiskSession).not.toHaveBeenCalled();
  });

  it("reports native persistence errors and does not manufacture a receipt", async () => {
    const f = await fixture();
    const failure = new Error("fsync failed");
    f.session.backup.mockImplementation(() => {
      throw failure;
    });
    const backup = f.open();
    await expect(backup.backupPartitionTable(f.target)).rejects.toBe(failure);
    f.session.backup.mockReturnValue(Buffer.alloc(31));
    await expect(backup.backupPartitionTable(f.target)).rejects.toThrow(
      /invalid durable artifact digest/,
    );
  });

  it("makes close idempotent and refuses further I/O after a close failure", async () => {
    const f = await fixture();
    const backup = f.open();
    f.session.close.mockImplementation(() => {
      throw new Error("close failed");
    });
    await expect(backup.close()).rejects.toThrow("close failed");
    await backup.close();
    await expect(backup.backupPartitionTable(f.target)).rejects.toThrow(
      /closed/,
    );
    expect(f.session.close).toHaveBeenCalledTimes(1);
    expect(f.session.backup).not.toHaveBeenCalled();
  });
  it("advances only reviewed GPT actions using exact native readback digests", async () => {
    const f = await fixture();
    const session = f.open();
    const backup = await session.backupPartitionTable(f.target);
    const actions = f.plan.actions.filter(
      (action) =>
        action.type === "erase-partition-table" ||
        action.type === "create-partition",
    );
    const changed = Buffer.alloc(48, 0xbb);
    changed.writeBigUInt64LE(34304n, 32);
    changed.writeUInt32LE(0, 40);
    changed.writeUInt32LE(0, 44);
    f.session.editGpt.mockReturnValue(changed);
    await expect(
      session.applyGptEdit(actions[1], f.target, backup),
    ).rejects.toThrow(/next partition operation/);
    await expect(
      session.applyGptEdit(actions[0], f.target, backup),
    ).resolves.toEqual({
      sha256: "bb".repeat(32),
      bytesWritten: 34304,
      partitionIndex: 0,
      partitionCount: 0,
    });
    await expect(
      session.applyGptEdit(actions[0], f.target, backup),
    ).rejects.toThrow(/next partition operation/);
    changed.writeUInt32LE(1, 40);
    changed.writeUInt32LE(1, 44);
    await session.applyGptEdit(actions[1], f.target, backup);
    expect(f.session.editGpt.mock.calls[1][2]).toEqual(Buffer.alloc(32, 0xbb));
    expect(f.session.editGpt.mock.calls[1][1]).toEqual(Buffer.alloc(32, 0xaa));
    await expect(session.backupPartitionTable(f.target)).rejects.toThrow(
      /cannot be recaptured/,
    );
    const other = {
      ...backup,
      sha256: "cc".repeat(32),
      location: `/recovery/backups/${"cc".repeat(32)}.gpt`,
    };
    await expect(
      session.verifyPartitionTableBackup(other, f.target),
    ).rejects.toThrow(/receipt/);
  });

  it("requires recovery after a native mutation failure and never fabricates a receipt", async () => {
    const f = await fixture();
    const session = f.open();
    const backup = await session.backupPartitionTable(f.target);
    const action = f.plan.actions[0];
    if (action.type !== "erase-partition-table")
      throw new Error("erase fixture missing");
    f.session.editGpt.mockImplementation(() => {
      throw new Error("GPT write failed after 512 bytes");
    });
    await expect(
      session.applyGptEdit(action, f.target, backup),
    ).rejects.toThrow(/write failed/);
    await expect(
      session.applyGptEdit(action, f.target, backup),
    ).rejects.toThrow(/explicit recovery/);
    expect(f.session.editGpt).toHaveBeenCalledTimes(1);
    await expect(
      session.verifyPartitionTableBackup(backup, f.target),
    ).resolves.toBe(true);
  });
  async function imageFixture() {
    const f = await fixture();
    const disk = f.open();
    const backup = await disk.backupPartitionTable(f.target);
    const erase = f.plan.actions[0];
    const create = f.plan.actions[1];
    if (
      erase.type !== "erase-partition-table" ||
      create.type !== "create-partition"
    )
      throw new Error("partition fixture missing");
    const metadata = Buffer.alloc(48, 0xbb);
    metadata.writeBigUInt64LE(34304n, 32);
    metadata.writeUInt32LE(0, 40);
    metadata.writeUInt32LE(0, 44);
    f.session.editGpt.mockReturnValue(metadata);
    await disk.applyGptEdit(erase, f.target, backup);
    metadata.writeUInt32LE(1, 40);
    metadata.writeUInt32LE(1, 44);
    await disk.applyGptEdit(create, f.target, backup);
    const image = {
      sha256: "cc".repeat(32),
      sizeBytes: create.partition.endBytes - create.partition.startBytes,
      filesystem: create.partition.filesystem,
      uuid: "1234-ABCD",
      storageStableId: f.storage.disk.stableId,
    };
    return { ...f, disk, backup, create, image };
  }

  it("binds the image write to the created partition, original backup and exact readback", async () => {
    const f = await imageFixture();
    const receipt = Buffer.alloc(40, 0xcc);
    receipt.writeBigUInt64LE(BigInt(f.image.sizeBytes), 32);
    f.session.writeImage.mockResolvedValue(receipt);
    await expect(
      f.disk.writePartitionImage(
        f.create.partition,
        f.image,
        f.target,
        f.backup,
      ),
    ).resolves.toEqual({
      sha256: f.image.sha256,
      bytesWritten: f.image.sizeBytes,
      partitionIndex: 1,
    });
    const call = f.session.writeImage.mock.calls[0];
    expect(call[1]).toEqual(Buffer.alloc(32, 0xaa));
    expect(call[2]).toEqual(Buffer.alloc(32, 0xbb));
    expect(call[3].readUInt32LE(0)).toBe(1);
    expect(call[3].readBigUInt64LE(8)).toBe(BigInt(f.image.sizeBytes));
    expect(call[3].readBigUInt64LE(16)).toBe(
      BigInt(Date.parse(f.plan.authorization.expiresAt)),
    );
  });

  it("refuses images for other media, sizes or partitions before native I/O", async () => {
    const f = await imageFixture();
    for (const patch of [
      { storageStableId: "other" },
      { sizeBytes: 1 },
      { sha256: "not-a-digest" },
      { filesystem: "ext4" as const },
    ]) {
      await expect(
        f.disk.writePartitionImage(
          f.create.partition,
          { ...f.image, ...patch },
          f.target,
          f.backup,
        ),
      ).rejects.toThrow(/not bound/);
    }
    await expect(
      f.disk.writePartitionImage(
        { startBytes: 0, endBytes: 1 },
        f.image,
        f.target,
        f.backup,
      ),
    ).rejects.toThrow(/not bound/);
    expect(f.session.writeImage).not.toHaveBeenCalled();
  });

  it("cancels the worker but retains handles until its promise settles", async () => {
    const f = await imageFixture();
    const abort = new AbortController();
    let rejectWorker: (error: Error) => void = () => {};
    const worker = new Promise<Buffer>((_resolve, reject) => {
      rejectWorker = reject;
    });
    f.session.writeImage.mockReturnValue(worker);
    let settled = false;
    const operation = f.disk
      .writePartitionImage(
        f.create.partition,
        f.image,
        f.target,
        f.backup,
        abort.signal,
      )
      .finally(() => {
        settled = true;
      });
    const rejected = expect(operation).rejects.toThrow("cancelled after write");
    abort.abort();
    expect(f.session.cancelImageWrite).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    await expect(f.disk.close()).rejects.toThrow(/settle before closing/);
    expect(f.session.close).not.toHaveBeenCalled();
    await expect(f.disk.backupPartitionTable(f.target)).rejects.toThrow(
      /still running/,
    );
    rejectWorker(new Error("cancelled after write"));
    await rejected;
    await expect(
      f.disk.writePartitionImage(
        f.create.partition,
        f.image,
        f.target,
        f.backup,
      ),
    ).rejects.toThrow(/explicit recovery/);
    await f.disk.close();
    expect(f.session.close).toHaveBeenCalledTimes(1);
  });

  it("refuses native image completion without the full expected receipt", async () => {
    const f = await imageFixture();
    const incomplete = Buffer.alloc(40, 0xcc);
    incomplete.writeBigUInt64LE(1n, 32);
    f.session.writeImage.mockResolvedValue(incomplete);
    await expect(
      f.disk.writePartitionImage(
        f.create.partition,
        f.image,
        f.target,
        f.backup,
      ),
    ).rejects.toThrow(/does not prove/);
    await expect(
      f.disk.writePartitionImage(
        f.create.partition,
        f.image,
        f.target,
        f.backup,
      ),
    ).rejects.toThrow(/explicit recovery/);
  });
});
