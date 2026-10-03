import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiskConfirmationToken,
  createDiskInventoryFingerprint,
  createInstallPlan,
} from "./planner";
import {
  type InstallOperationSession,
  InstallServiceError,
  type LocalInstallExecutionRequest,
  PrivilegedInstallService,
  type PrivilegedInstallServiceDependencies,
  parseLocalInstallExecutionFrame,
} from "./root-service";
import {
  applyTestInventoryAction,
  createTestDiskInventory,
} from "./test-inventory";
import type { InstallJournalEntry } from "./types";

beforeEach(() => vi.spyOn(process, "geteuid").mockReturnValue(0));
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const target = createTestDiskInventory();
  const request = {
    mode: "erase-disk" as const,
    targetStableId: target.stableId,
    expectedSizeBytes: target.sizeBytes,
    confirmationToken: createDiskConfirmationToken(target),
  };
  const plan = createInstallPlan(request, target);
  const message: LocalInstallExecutionRequest = {
    schemaVersion: 1,
    operation: "execute-reviewed-plan",
    request,
    plan,
    authorization: {
      planId: plan.planId,
      inventoryFingerprint: createDiskInventoryFingerprint(target),
      ownerId: "local-owner-1000",
      issuedAt: "2026-09-24T00:00:00.000Z",
      expiresAt: "2026-09-24T00:10:00.000Z",
      nonce: "test-approval-123",
      credential: "test-owner-approval",
    },
  };
  const events: string[] = [];
  const journal: InstallJournalEntry[] = [];
  let locked = false;
  const operations: InstallOperationSession = {
    backupPartitionTable: async () => ({
      stableId: target.stableId,
      storageStableId: "separate-storage",
      location: "/recovery/snapshot.gpt",
      sha256: "a".repeat(64),
    }),
    verifyPartitionTableBackup: async () => true,
    apply: async (action) => {
      expect(locked).toBe(true);
      applyTestInventoryAction(target, action);
      return {
        receiptId: "b".repeat(64),
        actionDigest: createHash("sha256")
          .update(JSON.stringify(action))
          .digest("hex"),
      };
    },
    close: async () => {
      expect(locked).toBe(true);
      events.push("close");
    },
  };
  const dependencies: PrivilegedInstallServiceDependencies = {
    now: () => new Date("2026-09-24T00:05:00.000Z"),
    inventory: { inspect: async () => structuredClone(target) },
    authorization: { verify: async () => true },
    journal: {
      read: async () => structuredClone(journal),
      append: async (entry) => {
        journal.push(structuredClone(entry));
      },
    },
    operations: {
      open: vi.fn(async (_plan, inventory) => {
        expect(locked).toBe(true);
        expect(inventory).toEqual(target);
        expect(inventory).not.toBe(target);
        events.push("open");
        return operations;
      }),
    },
    activeOwner: {
      inspectForProcess: async () => ({
        ownerId: "local-owner-1000",
        uid: 1000,
        sessionId: "owner-session",
        active: true,
        locked: false,
      }),
    },
    replay: { claim: async () => true },
    targets: {
      runExclusive: async (_physical, _kernel, _plan, operation) => {
        locked = true;
        events.push("lock");
        try {
          const result = await operation();
          events.push("release");
          return result;
        } catch (error) {
          events.push("retain");
          throw error;
        } finally {
          locked = false;
        }
      },
    },
  };
  const peer = {
    transport: "unix" as const,
    uid: 1000,
    gid: 1000,
    process: { pid: 123, livenessToken: {} },
  };
  const run = (signal?: AbortSignal) =>
    new PrivilegedInstallService(dependencies).execute(message, peer, signal);
  return { target, message, events, operations, dependencies, run };
}

describe("installer operations session lifetime", () => {
  it("reports typed frame errors with the original decoding cause", () => {
    for (const frame of [Buffer.from([0xff]), Buffer.from("{")]) {
      let error: unknown;
      try {
        parseLocalInstallExecutionFrame(frame);
      } catch (failure) {
        error = failure;
      }
      expect(error).toBeInstanceOf(InstallServiceError);
      expect(error).toMatchObject({
        code: "ELIZAOS_INSTALL_SERVICE_ERROR",
        cause: expect.any(Error),
      });
    }
  });
  it("opens only under the authenticated target lock and closes before releasing it", async () => {
    const f = fixture();
    await f.run();
    expect(f.events).toEqual(["lock", "open", "close", "release"]);
  });

  it("does not open a native session when owner credential verification fails", async () => {
    const f = fixture();
    f.dependencies.authorization.verify = async () => false;
    await expect(f.run()).rejects.toThrow(/credential verification failed/);
    expect(f.events).toEqual([]);
    expect(f.dependencies.operations.open).not.toHaveBeenCalled();
  });

  it("preserves a session-provider failure during repeated authorization", async () => {
    const f = fixture();
    const inspect = f.dependencies.activeOwner.inspectForProcess;
    const failure = new Error("logind connection lost");
    let calls = 0;
    f.dependencies.activeOwner.inspectForProcess = async (...args) => {
      if (++calls === 2) throw failure;
      return inspect(...args);
    };
    await expect(f.run()).rejects.toBe(failure);
    expect(calls).toBe(2);
    expect(f.events).toEqual([]);
    expect(f.dependencies.operations.open).not.toHaveBeenCalled();
  });

  it("reproduces the authorized inventory after waiting for the lock", async () => {
    const f = fixture();
    const lock = f.dependencies.targets.runExclusive;
    f.dependencies.targets.runExclusive = async (...args) => {
      f.target.kernelDeviceIdentity = "8:16:43";
      return lock(...args);
    };
    await expect(f.run()).rejects.toThrow();
    expect(f.events).toEqual(["lock", "retain"]);
    expect(f.dependencies.operations.open).not.toHaveBeenCalled();
  });

  it("closes an acquired session if cancellation arrives during open", async () => {
    const f = fixture();
    const abort = new AbortController();
    const open = f.dependencies.operations.open;
    f.dependencies.operations.open = async (...args) => {
      const session = await open(...args);
      abort.abort(new Error("cancel while opening"));
      return session;
    };
    await expect(f.run(abort.signal)).rejects.toThrow("cancel while opening");
    expect(f.events).toEqual(["lock", "open", "close", "retain"]);
  });

  it("preserves both execution and cleanup errors and retains the target lock", async () => {
    const f = fixture();
    const writeError = new Error("backup storage unavailable");
    const closeError = new Error("native close failed");
    f.operations.backupPartitionTable = async () => {
      throw writeError;
    };
    f.operations.close = async () => {
      f.events.push("close");
      throw closeError;
    };
    const error = await f.run().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([writeError, closeError]);
    expect(f.events).toEqual(["lock", "open", "close", "retain"]);
  });

  it("does not advertise success when closing a completed session fails", async () => {
    const f = fixture();
    f.operations.close = async () => {
      f.events.push("close");
      throw new Error("close failed");
    };
    await expect(f.run()).rejects.toThrow("close failed");
    expect(f.events).toEqual(["lock", "open", "close", "retain"]);
  });

  it("holds the target lock until asynchronous cleanup settles", async () => {
    const f = fixture();
    let enteredResolve = () => {};
    let releaseResolve = () => {};
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    f.operations.close = async () => {
      f.events.push("closing");
      enteredResolve();
      await release;
      f.events.push("closed");
    };
    const execution = f.run();
    await entered;
    expect(f.events).toEqual(["lock", "open", "closing"]);
    releaseResolve();
    await execution;
    expect(f.events).toEqual(["lock", "open", "closing", "closed", "release"]);
  });
});
