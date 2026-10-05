import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FactorySourceOptions } from "./factory-source";
import { createDiskConfirmationToken, createInstallPlan } from "./planner";
import { PreparedInstallOperationFactory } from "./prepared-operations";
import { createTestDiskInventory } from "./test-inventory";
import type { AuthorizedInstallPlan } from "./types";

const mocks = vi.hoisted(() => ({
  stage: vi.fn(),
  build: vi.fn(),
  backup: vi.fn(),
  verify: vi.fn(),
  edit: vi.fn(),
  write: vi.fn(),
  close: vi.fn(),
  open: vi.fn(),
}));
vi.mock("./prepare-installation", () => ({
  prepareInstallationFilesystems: mocks.stage,
}));
vi.mock("./filesystem-image", () => ({ buildFilesystemImage: mocks.build }));
vi.mock("./linux-native-disk", () => ({
  NativeLinuxInstallDiskSession: class {
    constructor(...args: unknown[]) {
      mocks.open(...args);
    }
    backupPartitionTable = mocks.backup;
    verifyPartitionTableBackup = mocks.verify;
    applyGptEdit = mocks.edit;
    writePartitionImage = mocks.write;
    close = mocks.close;
  },
}));

function fixture() {
  const inventory = createTestDiskInventory();
  const reviewed = createInstallPlan(
    {
      mode: "erase-disk",
      targetStableId: inventory.stableId,
      expectedSizeBytes: inventory.sizeBytes,
      confirmationToken: createDiskConfirmationToken(inventory),
    },
    inventory,
  );
  // Isolate composition; real authorization and native effects have their own
  // service tests and disposable-disk qualification, not these mock receipts.
  const plan = {
    ...reviewed,
    executable: true,
    authorization: {},
  } as AuthorizedInstallPlan;
  const selected = {
    options: {
      storage: { disk: { stableId: "store" } },
    } as FactorySourceOptions,
    close: vi.fn(async () => {}),
  };
  const sources = { open: vi.fn(async () => selected) };
  return {
    inventory,
    plan,
    selected,
    sources,
    factory: new PreparedInstallOperationFactory(sources),
  };
}
function actionAt(plan: AuthorizedInstallPlan, index: number) {
  const action = plan.actions[index];
  if (!action) throw new Error(`Missing fixture action ${index}`);
  return action;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.stage.mockResolvedValue({
    images: {
      root: { sha256: "root" },
      esp: { sha256: "esp" },
      recovery: { sha256: "recovery" },
      state: { sha256: "state" },
    },
  });
  mocks.build.mockImplementation(async (_storage, partition) => ({
    sha256: `empty-${partition.role}`,
  }));
  mocks.backup.mockResolvedValue({
    stableId: "target",
    storageStableId: "store",
    location: "backup",
    sha256: "a".repeat(64),
  });
  mocks.verify.mockResolvedValue(true);
  mocks.edit.mockResolvedValue({ sha256: "gpt", bytesWritten: 4096 });
  mocks.write.mockResolvedValue({ sha256: "image", bytesWritten: 8192 });
});

describe("prepared installation operations", () => {
  it.each(["capture", "verify"] as const)(
    "waits for backup %s to settle and rejects cancellation without further effects",
    async (operation) => {
      const f = fixture();
      const controller = new AbortController();
      const session = await f.factory.open(
        f.plan,
        f.inventory,
        controller.signal,
      );
      const backup = await session.backupPartitionTable(f.inventory);
      let finish!: (value: unknown) => void;
      const target = operation === "capture" ? mocks.backup : mocks.verify;
      target.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending =
        operation === "capture"
          ? session.backupPartitionTable(f.inventory)
          : session.verifyPartitionTableBackup(backup, f.inventory);
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      const reason = new Error("owner cancelled during backup");
      const rejected = expect(pending).rejects.toBe(reason);
      controller.abort(reason);
      const closing = session.close();
      expect(mocks.close).not.toHaveBeenCalled();
      finish(operation === "capture" ? backup : true);
      await rejected;
      await closing;
      expect(mocks.close).toHaveBeenCalledOnce();
      expect(f.selected.close).toHaveBeenCalledOnce();
      await expect(
        session.apply(actionAt(f.plan, 0), f.inventory),
      ).rejects.toThrow(/closing|recovery/);
      expect(mocks.edit).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    },
  );
  it("does not start a filesystem write after cancellation during a GPT edit", async () => {
    const f = fixture();
    const controller = new AbortController();
    const session = await f.factory.open(
      f.plan,
      f.inventory,
      controller.signal,
    );
    await session.backupPartitionTable(f.inventory);
    await session.apply(actionAt(f.plan, 0), f.inventory);
    const reason = new Error("cancelled after GPT edit");
    mocks.edit.mockImplementationOnce(async () => {
      controller.abort(reason);
      return { sha256: "gpt", bytesWritten: 4096 };
    });
    await expect(session.apply(actionAt(f.plan, 1), f.inventory)).rejects.toBe(
      reason,
    );
    expect(mocks.write).not.toHaveBeenCalled();
    await session.close();
  });
  it("never retries a partition whose GPT edit succeeded but image write failed", async () => {
    const f = fixture();
    const session = await f.factory.open(f.plan, f.inventory);
    await session.backupPartitionTable(f.inventory);
    await session.apply(actionAt(f.plan, 0), f.inventory);
    mocks.write.mockRejectedValueOnce(
      new Error("readback failed after partial write"),
    );
    await expect(
      session.apply(actionAt(f.plan, 1), f.inventory),
    ).rejects.toThrow(/partial write/);
    await expect(
      session.apply(actionAt(f.plan, 1), f.inventory),
    ).rejects.toThrow(/requires recovery/);
    expect(mocks.edit).toHaveBeenCalledTimes(2);
    expect(mocks.write).toHaveBeenCalledTimes(1);
    await session.close();
  });
  it("retains both native and source cleanup failures without releasing twice", async () => {
    const f = fixture();
    const session = await f.factory.open(f.plan, f.inventory);
    const nativeError = new Error("native close failed");
    const sourceError = new Error("source close failed");
    mocks.close.mockRejectedValue(nativeError);
    f.selected.close.mockRejectedValue(sourceError);
    const closing = session.close();
    expect(session.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({
      code: "ELIZAOS_INSTALL_OPERATIONS_ERROR",
      cause: { errors: [nativeError, sourceError] },
    });
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(f.selected.close).toHaveBeenCalledTimes(1);
    await expect(session.backupPartitionTable(f.inventory)).rejects.toThrow(
      /closing/,
    );
  });
  it("snapshots action and inventory inputs before yielding", async () => {
    const f = fixture();
    const session = await f.factory.open(f.plan, f.inventory);
    const original = structuredClone(f.inventory);
    const backup = session.backupPartitionTable(f.inventory);
    f.inventory.path = "/dev/changed";
    await backup;
    expect(mocks.backup).toHaveBeenCalledWith(original);
    const action = structuredClone(actionAt(f.plan, 0));
    const expected = structuredClone(action);
    const operation = session.apply(action, original);
    if (action.type !== "erase-partition-table")
      throw new Error("Unexpected fixture action");
    action.diskStableId = "changed";
    await operation;
    expect(mocks.edit.mock.calls[0]?.[0]).toEqual(expected);
    await session.close();
  });
  it("prepares before backup and binds each action to actual native effect receipts", async () => {
    const f = fixture();
    const session = await f.factory.open(f.plan, f.inventory);
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
    const backup = await session.backupPartitionTable(f.inventory);
    await session.verifyPartitionTableBackup(backup, f.inventory);
    for (const action of f.plan.actions) {
      const receipt = await session.apply(action, f.inventory);
      expect(receipt.actionDigest).toBe(
        createHash("sha256").update(JSON.stringify(action)).digest("hex"),
      );
      expect(receipt.receiptId).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(mocks.write.mock.calls.map((call) => call[1].sha256)).toEqual([
      "empty-esp",
      "recovery",
      "empty-root",
      "state",
      "root",
      "esp",
    ]);
    await session.close();
    await session.close();
    expect(mocks.close).toHaveBeenCalledTimes(1);
    expect(f.selected.close).toHaveBeenCalledTimes(1);
  });
  it("rejects unsupported preservation work before selecting or opening devices", async () => {
    const f = fixture();
    f.plan.actions.unshift({
      type: "reuse-esp",
      partitionId: "existing",
      destructive: false,
    });
    await expect(f.factory.open(f.plan, f.inventory)).rejects.toThrow(
      /preservation-aware/,
    );
    expect(f.sources.open).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("closes selected and native resources if filesystem preparation fails", async () => {
    const f = fixture();
    mocks.stage.mockRejectedValue(new Error("invalid signature"));
    await expect(f.factory.open(f.plan, f.inventory)).rejects.toThrow(
      /before target mutation/,
    );
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(f.selected.close).toHaveBeenCalledOnce();
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("refuses out-of-order actions and requires recovery afterward", async () => {
    const f = fixture();
    const session = await f.factory.open(f.plan, f.inventory);
    await session.backupPartitionTable(f.inventory);
    await expect(
      session.apply(actionAt(f.plan, 1), f.inventory),
    ).rejects.toThrow(/next reviewed action/);
    await expect(
      session.apply(actionAt(f.plan, 0), f.inventory),
    ).rejects.toThrow(/requires recovery/);
    expect(mocks.edit).not.toHaveBeenCalled();
    await session.close();
  });
  it("settles an active write before close and never issues success after cancellation", async () => {
    const f = fixture();
    const controller = new AbortController();
    const session = await f.factory.open(
      f.plan,
      f.inventory,
      controller.signal,
    );
    await session.backupPartitionTable(f.inventory);
    await session.apply(actionAt(f.plan, 0), f.inventory);
    let finish: (value: unknown) => void = () => {
      throw new Error("write not started");
    };
    mocks.write.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const operation = session.apply(actionAt(f.plan, 1), f.inventory);
    await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
    const rejected = expect(operation).rejects.toThrow();
    controller.abort(new Error("cancelled"));
    const closing = session.close();
    expect(mocks.close).not.toHaveBeenCalled();
    finish({ sha256: "image", bytesWritten: 8192 });
    await rejected;
    await closing;
    expect(mocks.close).toHaveBeenCalledOnce();
  });
});
