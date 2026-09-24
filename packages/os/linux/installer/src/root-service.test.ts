import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InstallExecutionDependencies, InstallJournal } from "./executor";
import { DurableFileInstallServiceState } from "./file-service-state";
import {
  createDiskConfirmationToken,
  createDiskExecutionIdentity,
  createDiskInventoryFingerprint,
  createInstallPlan,
} from "./planner";
import {
  type ActiveOwnerSession,
  type LocalInstallExecutionRequest,
  PrivilegedInstallService,
  type PrivilegedInstallServiceDependencies,
  parseLocalInstallExecutionFrame,
} from "./root-service";
import { applyTestInventoryAction } from "./test-inventory";
import type {
  DiskInventory,
  InstallAuthorization,
  InstallerAction,
  InstallJournalEntry,
  InstallRequest,
} from "./types";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const NOW = new Date("2026-08-26T02:00:00.000Z");
const PROCESS_TOKEN = {};
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
const PEER = {
  transport: "unix" as const,
  uid: 1000,
  gid: 1000,
  process: { pid: 4242, livenessToken: PROCESS_TOKEN },
};

beforeEach(() => {
  vi.spyOn(process, "geteuid").mockReturnValue(0);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function disk(): DiskInventory {
  return {
    stableId: "wwn-0x5000c50012345678",
    path: "/dev/disk/by-id/wwn-0x5000c50012345678",
    hardwareIdentity: {
      serial: "Z4D3ABCD",
      wwn: "0x5000c50012345678",
      firmwarePath: "/sys/devices/pci0000:00/0000:00:17.0",
      gptDiskGuid: "f73cab3d-5f8c-43e6-9092-00fef09bd497",
    },
    sizeBytes: 256 * GIB,
    logicalSectorBytes: 4096,
    partitionTable: "gpt",
    gptRedundancyVerified: true,
    bootAncestryResolved: true,
    currentBootSource: false,
    firmware: "uefi",
    partitions: [
      {
        id: "old-root",
        startBytes: MIB,
        endBytes: 128 * GIB,
        mounted: false,
        role: "os",
        filesystem: "ext4",
        osFamily: "linux",
        encryption: "none",
      },
    ],
    freeExtents: [{ id: "free", startBytes: 128 * GIB, endBytes: 255 * GIB }],
  };
}

function actionDigest(action: InstallerAction): string {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

class MemoryJournal implements InstallJournal {
  readonly entries: InstallJournalEntry[] = [];

  async read(planId: string): Promise<InstallJournalEntry[]> {
    return this.entries.filter((entry) => entry.planId === planId);
  }

  async append(entry: InstallJournalEntry): Promise<void> {
    this.entries.push(structuredClone(entry));
  }
}

function fixture(target: DiskInventory = disk()): {
  message: LocalInstallExecutionRequest;
  target: DiskInventory;
} {
  const request: InstallRequest = {
    mode: "erase-disk",
    targetStableId: target.stableId,
    expectedSizeBytes: target.sizeBytes,
    confirmationToken: createDiskConfirmationToken(target),
  };
  const plan = createInstallPlan(request, target);
  const authorization: InstallAuthorization = {
    planId: plan.planId,
    inventoryFingerprint: createDiskInventoryFingerprint(target),
    ownerId: "local-owner-1000",
    issuedAt: "2026-08-26T01:55:00.000Z",
    expiresAt: "2026-08-26T02:05:00.000Z",
    nonce: "local-confirmation-123",
    credential: "signed-local-owner-confirmation",
  };
  return {
    target,
    message: {
      schemaVersion: 1,
      operation: "execute-reviewed-plan",
      request,
      plan,
      authorization,
    },
  };
}

function dependencies(
  target: DiskInventory,
  overrides: Partial<PrivilegedInstallServiceDependencies> = {},
): PrivilegedInstallServiceDependencies & {
  applied: InstallerAction[];
  claimed: InstallAuthorization[];
} {
  const journal = new MemoryJournal();
  const applied: InstallerAction[] = [];
  const claimed: InstallAuthorization[] = [];
  const owner: ActiveOwnerSession = {
    ownerId: "local-owner-1000",
    uid: 1000,
    sessionId: "session-7",
    active: true,
    locked: false,
  };
  const base: InstallExecutionDependencies = {
    inventory: { inspect: async () => structuredClone(target) },
    authorization: { verify: async () => true },
    journal,
    operations: {
      backupPartitionTable: async (inventory) => ({
        stableId: inventory.stableId,
        storageStableId: "installer-media",
        location: "/run/elizaos-installer/recovery/gpt.bin",
        sha256: "a".repeat(64),
      }),
      verifyPartitionTableBackup: async () => true,
      apply: async (action) => {
        applyTestInventoryAction(target, action);
        applied.push(structuredClone(action));
        return {
          receiptId: `receipt-${action.type}`,
          actionDigest: actionDigest(action),
        };
      },
    },
    now: () => NOW,
  };
  return {
    ...base,
    activeOwner: {
      inspectForProcess: async (process) =>
        process.pid === PEER.process.pid &&
        process.livenessToken === PROCESS_TOKEN
          ? owner
          : null,
    },
    replay: {
      claim: async (authorization) => {
        claimed.push(structuredClone(authorization));
        return true;
      },
    },
    targets: {
      runExclusive: async (
        _physicalIdentity,
        _kernelDeviceIdentity,
        _planId,
        operation,
      ) => operation(),
    },
    ...overrides,
    applied,
    claimed,
  };
}

describe("privileged installer root-service core", () => {
  it("rejects an already cancelled request before inspecting or consuming state", async () => {
    const { message, target } = fixture();
    const deps = dependencies(target);
    const inspect = vi.spyOn(deps.inventory, "inspect");
    await expect(
      new PrivilegedInstallService(deps).execute(
        message,
        PEER,
        AbortSignal.abort(new Error("cancelled")),
      ),
    ).rejects.toThrow("cancelled");
    expect(inspect).not.toHaveBeenCalled();
    expect(deps.claimed).toHaveLength(0);
  });

  it.each(["owner", "credential", "inventory", "replay"] as const)(
    "stops cancellation during %s admission before acquiring a target lock",
    async (boundary) => {
      const { message, target } = fixture();
      const deps = dependencies(target);
      const controller = new AbortController();
      const cancel = () => controller.abort(new Error("cancelled"));
      if (boundary === "owner") {
        const inspect = deps.activeOwner.inspectForProcess;
        deps.activeOwner.inspectForProcess = async (process) => {
          const owner = await inspect(process);
          cancel();
          return owner;
        };
      } else if (boundary === "credential") {
        deps.authorization.verify = async () => {
          cancel();
          return true;
        };
      } else if (boundary === "inventory") {
        deps.inventory.inspect = async () => {
          cancel();
          return target;
        };
      } else {
        deps.replay.claim = async () => {
          cancel();
          return true;
        };
      }
      const lock = vi.spyOn(deps.targets, "runExclusive");
      await expect(
        new PrivilegedInstallService(deps).execute(
          message,
          PEER,
          controller.signal,
        ),
      ).rejects.toThrow("cancelled");
      expect(lock).not.toHaveBeenCalled();
      expect(deps.applied).toHaveLength(0);
    },
  );

  it("honors the trusted mutation hook and rechecks cancellation before backup", async () => {
    const { message, target } = fixture();
    const controller = new AbortController();
    const hook = vi.fn(async () => controller.abort(new Error("cancelled")));
    const deps = dependencies(target, { beforePrivilegedMutation: hook });
    const backup = vi.spyOn(deps.operations, "backupPartitionTable");
    await expect(
      new PrivilegedInstallService(deps).execute(
        message,
        PEER,
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
    expect(hook).toHaveBeenCalledWith("partition-table-backup");
    expect(backup).not.toHaveBeenCalled();
    expect(deps.applied).toHaveLength(0);
  });

  it("retains the durable physical lock when a valid receipt fails readback", async () => {
    const root = await mkdtemp(
      join(await realpath(tmpdir()), "installer-readback-"),
    );
    try {
      await mkdir(join(root, "authorizations"), { mode: 0o700 });
      await mkdir(join(root, "targets"), { mode: 0o700 });
      const uid = (await lstat(root)).uid;
      vi.spyOn(process, "geteuid").mockReturnValue(uid).mockReturnValueOnce(0);
      const state = new DurableFileInstallServiceState(root);
      const { message, target } = fixture();
      const deps = dependencies(target, { targets: state, replay: state });
      let calls = 0;
      deps.operations.apply = async (action) => {
        calls += 1;
        return { receiptId: "no-op", actionDigest: actionDigest(action) };
      };
      await expect(
        new PrivilegedInstallService(deps).execute(message, PEER),
      ).rejects.toThrow("lock is retained");
      expect(calls).toBe(1);
      const entries = await deps.journal.read(message.plan.planId);
      expect(entries.at(-1)?.event).toBe("execution-failed");
      expect(entries.some((entry) => entry.event === "action-completed")).toBe(
        false,
      );
      expect(await readdir(join(root, "targets"))).toHaveLength(1);
      await expect(
        state.runExclusive(
          createDiskExecutionIdentity(target),
          undefined,
          message.plan.planId,
          async () => {
            throw new Error("must not run");
          },
        ),
      ).rejects.toThrow("target lock already exists");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["backup", "action", "completion"] as const)(
    "waits for an in-flight %s and retains the real durable target lock after cancellation",
    async (boundary) => {
      const root = await mkdtemp(
        join(await realpath(tmpdir()), "installer-abort-"),
      );
      try {
        await mkdir(join(root, "authorizations"), { mode: 0o700 });
        await mkdir(join(root, "targets"), { mode: 0o700 });
        // Only the request entry's root check is mocked. Filesystem state uses
        // the test process's actual UID and real durable lock implementation.
        const uid = (await lstat(root)).uid;
        vi.spyOn(process, "geteuid")
          .mockReturnValue(uid)
          .mockReturnValueOnce(0);
        const state = new DurableFileInstallServiceState(root);
        const { message, target } = fixture();
        const deps = dependencies(target, { targets: state, replay: state });
        const controller = new AbortController();
        const entered = deferred();
        const release = deferred();
        if (boundary === "backup") {
          const backup = deps.operations.backupPartitionTable;
          deps.operations.backupPartitionTable = async (inventory) => {
            entered.resolve();
            await release.promise;
            return backup(inventory);
          };
        } else if (boundary === "action") {
          const apply = deps.operations.apply;
          deps.operations.apply = async (action, inventory) => {
            entered.resolve();
            await release.promise;
            return apply(action, inventory);
          };
        } else {
          const journal = deps.journal;
          deps.journal = {
            read: (planId) => journal.read(planId),
            append: async (entry) => {
              if (entry.event === "execution-completed") {
                entered.resolve();
                await release.promise;
              }
              await journal.append(entry);
            },
          };
        }
        let settled = false;
        const result = new PrivilegedInstallService(deps)
          .execute(message, PEER, controller.signal)
          .then(
            () => {
              settled = true;
              return null;
            },
            (error: unknown) => {
              settled = true;
              return error;
            },
          );
        await entered.promise;
        controller.abort(new Error("cancelled"));
        await new Promise((resolve) => setImmediate(resolve));
        expect(settled).toBe(false);
        expect(await readdir(join(root, "targets"))).toHaveLength(1);
        release.resolve();
        const error = await result;
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("lock is retained");
        expect((error as Error).cause).toEqual(new Error("cancelled"));
        expect(deps.applied).toHaveLength(
          boundary === "completion"
            ? message.plan.actions.length
            : boundary === "action"
              ? 1
              : 0,
        );
        expect(await readdir(join(root, "targets"))).toHaveLength(1);
        await expect(
          state.runExclusive(
            createDiskExecutionIdentity(target),
            undefined,
            message.plan.planId,
            async () => "must not run",
          ),
        ).rejects.toThrow("target lock already exists");
        const journal = await deps.journal.read(message.plan.planId);
        expect(
          journal.some((entry) => entry.event === "execution-completed"),
        ).toBe(boundary === "completion");
        if (boundary === "action") {
          expect(journal.at(-1)?.event).toBe("execution-failed");
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("executes only the exact reviewed plan for an authenticated active owner", async () => {
    const { message, target } = fixture();
    let lockedIdentity: [string, string] | undefined;
    const deps = dependencies(target, {
      targets: {
        runExclusive: async (
          physicalIdentity,
          _generation,
          planId,
          operation,
        ) => {
          lockedIdentity = [physicalIdentity, planId];
          return operation();
        },
      },
    });

    const result = await new PrivilegedInstallService(deps).execute(
      message,
      PEER,
    );

    expect(result.planId).toBe(message.plan.planId);
    expect(result.completedActions).toBe(message.plan.actions.length);
    expect(lockedIdentity?.[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(lockedIdentity?.[1]).toBe(message.plan.planId);
    expect(deps.claimed).toHaveLength(1);
    expect(deps.applied).toEqual(message.plan.actions);
  });

  it("refuses to operate unless the service itself is root", async () => {
    const { message, target } = fixture();
    vi.spyOn(process, "geteuid").mockReturnValue(1000);
    const deps = dependencies(target);

    await expect(
      new PrivilegedInstallService(deps).execute(message, PEER),
    ).rejects.toThrow("must run as root");
    expect(deps.claimed).toHaveLength(0);
    expect(deps.applied).toHaveLength(0);
  });

  it.each([
    ["a root proxy", { ...PEER, uid: 0 }],
    ["a remote-shaped transport", { ...PEER, transport: "tcp" }],
    ["an invalid PID", { ...PEER, process: { ...PEER.process, pid: 0 } }],
  ])("rejects %s before authorization", async (_name, peer) => {
    const { message, target } = fixture();
    const deps = dependencies(target);

    await expect(
      new PrivilegedInstallService(deps).execute(message, peer as typeof PEER),
    ).rejects.toThrow(/Unix peer credentials/);
    expect(deps.claimed).toHaveLength(0);
  });

  it("rejects a caller outside the active owner session", async () => {
    const { message, target } = fixture();
    const deps = dependencies(target, {
      activeOwner: {
        inspectForProcess: async () => null,
      },
    });

    await expect(
      new PrivilegedInstallService(deps).execute(message, PEER),
    ).rejects.toThrow(/not the active unlocked owner/);
    expect(deps.claimed).toHaveLength(0);
    expect(deps.applied).toHaveLength(0);
  });

  it("rejects a peer whose adapter-owned liveness token does not match", async () => {
    const { message, target } = fixture();
    const deps = dependencies(target);
    const transferredPeer = {
      ...PEER,
      process: { ...PEER.process, livenessToken: {} },
    };

    await expect(
      new PrivilegedInstallService(deps).execute(message, transferredPeer),
    ).rejects.toThrow(/not the active unlocked owner/);
    expect(deps.claimed).toHaveLength(0);
  });

  it("consumes a verified nonce once and refuses replay before mutation", async () => {
    const { message, target } = fixture();
    const deps = dependencies(target, {
      replay: { claim: async () => false },
    });

    await expect(
      new PrivilegedInstallService(deps).execute(message, PEER),
    ).rejects.toThrow(/nonce was already used/);
    expect(deps.applied).toHaveLength(0);
  });

  it("rechecks the active owner immediately before every mutation", async () => {
    const { message, target } = fixture();
    let inspections = 0;
    const deps = dependencies(target, {
      activeOwner: {
        inspectForProcess: async () => {
          inspections += 1;
          return {
            ownerId: "local-owner-1000",
            uid: 1000,
            sessionId: "session-7",
            active: true,
            locked: inspections >= 6,
          };
        },
      },
    });

    await expect(
      new PrivilegedInstallService(deps).execute(message, PEER),
    ).rejects.toThrow(/not the active unlocked owner/);
    expect(deps.applied).toHaveLength(0);
  });

  it("derives the same execution lock identity for two by-id aliases", () => {
    const first = disk();
    const second = {
      ...first,
      stableId: "ata-Samsung_SSD_Z4D3ABCD",
      path: "/dev/disk/by-id/ata-Samsung_SSD_Z4D3ABCD",
    };
    expect(createDiskExecutionIdentity(first)).toBe(
      createDiskExecutionIdentity(second),
    );
  });

  it("keeps the durable lock across firmware-path and kernel re-enumeration", () => {
    const first = disk();
    const reenumerated = {
      ...first,
      stableId: "ata-Samsung_SSD_Z4D3ABCD",
      path: "/dev/disk/by-id/ata-Samsung_SSD_Z4D3ABCD",
      kernelDeviceIdentity: "8:32:41",
      hardwareIdentity: {
        ...first.hardwareIdentity,
        firmwarePath: "/sys/devices/pci0000:80/0000:80:01.0",
      },
    };

    expect(createDiskExecutionIdentity(reenumerated)).toBe(
      createDiskExecutionIdentity(first),
    );
  });

  it("keeps one lock when WWN presence changes for the same serial", () => {
    const first = disk();
    const withoutWwn = {
      ...first,
      hardwareIdentity: {
        ...first.hardwareIdentity,
        wwn: undefined,
      },
    };

    expect(createDiskExecutionIdentity(withoutWwn)).toBe(
      createDiskExecutionIdentity(first),
    );
  });

  it("maps duplicate serials to one conservative lock despite WWN drift", () => {
    const first = disk();
    const collision = {
      ...first,
      stableId: "usb-different-alias",
      path: "/dev/disk/by-id/usb-different-alias",
      hardwareIdentity: {
        ...first.hardwareIdentity,
        serial: "  z4d3abcd  ",
        wwn: "0x5000c50099999999",
        firmwarePath: "/sys/devices/pci0000:80/usb9/9-2",
      },
    };

    expect(createDiskExecutionIdentity(collision)).toBe(
      createDiskExecutionIdentity(first),
    );
  });

  it("rejects privileged execution without a durable serial", () => {
    const unidentified = disk();
    unidentified.hardwareIdentity.serial = "";

    expect(() => createDiskExecutionIdentity(unidentified)).toThrow(
      /durable serial/,
    );
  });

  it("rejects WWN-only execution before consuming replay state", async () => {
    const target = disk();
    target.hardwareIdentity.serial = "";
    const { message } = fixture(target);
    const deps = dependencies(target);

    await expect(
      new PrivilegedInstallService(deps).execute(message, PEER),
    ).rejects.toThrow(/durable serial/);
    expect(deps.claimed).toHaveLength(0);
    expect(deps.applied).toHaveLength(0);
  });

  it("rejects inventory drift before acquiring the physical lock", async () => {
    const { message, target } = fixture();
    let inspections = 0;
    let lockAttempts = 0;
    const deps = dependencies(target, {
      inventory: {
        inspect: async () => {
          inspections += 1;
          return inspections === 1
            ? structuredClone(target)
            : { ...structuredClone(target), kernelDeviceIdentity: "8:16:99" };
        },
      },
      targets: {
        runExclusive: async (_physical, _generation, _plan, operation) => {
          lockAttempts += 1;
          return operation();
        },
      },
    });

    await expect(
      new PrivilegedInstallService(deps).execute(message, PEER),
    ).rejects.toThrow(/changed before its physical execution lock/);
    expect(lockAttempts).toBe(0);
    expect(deps.applied).toHaveLength(0);
  });

  it("suppresses partition-table backup when the owner locks", async () => {
    const { message, target } = fixture();
    let inspections = 0;
    let backups = 0;
    const deps = dependencies(target, {
      activeOwner: {
        inspectForProcess: async () => {
          inspections += 1;
          return {
            ownerId: "local-owner-1000",
            uid: 1000,
            sessionId: "session-7",
            active: true,
            locked: inspections >= 4,
          };
        },
      },
      operations: {
        backupPartitionTable: async () => {
          backups += 1;
          throw new Error("must not run");
        },
        verifyPartitionTableBackup: async () => true,
        apply: async () => {
          throw new Error("must not run");
        },
      },
    });

    await expect(
      new PrivilegedInstallService(deps).execute(message, PEER),
    ).rejects.toThrow(/not the active unlocked owner/);
    expect(backups).toBe(0);
  });

  it("rejects an oversized raw frame before parsing JSON", () => {
    const frame = Buffer.alloc(1024 * 1024 + 1, 0x20);
    expect(() => parseLocalInstallExecutionFrame(frame)).toThrow(
      /frame exceeds/,
    );
  });

  it("rejects decoded strings at the raw IPC frame boundary", () => {
    expect(() =>
      parseLocalInstallExecutionFrame("{}" as unknown as Uint8Array),
    ).toThrow(/raw bytes/);
  });

  it("rejects malformed UTF-8 instead of decoding replacement characters", () => {
    expect(() =>
      parseLocalInstallExecutionFrame(
        Uint8Array.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
      ),
    ).toThrow(/UTF-8/);
  });

  it("rejects unsupported IPC fields instead of forwarding renderer data", async () => {
    const { message, target } = fixture();
    const deps = dependencies(target);

    await expect(
      new PrivilegedInstallService(deps).execute(
        { ...message, command: "/usr/bin/sh" },
        PEER,
      ),
    ).rejects.toThrow(/unsupported fields/);
    expect(deps.claimed).toHaveLength(0);
    expect(deps.applied).toHaveLength(0);
  });

  it("rejects unsupported nested request fields at the IPC boundary", async () => {
    const { message, target } = fixture();
    const deps = dependencies(target);

    await expect(
      new PrivilegedInstallService(deps).execute(
        { ...message, request: { ...message.request, argv: ["/bin/sh"] } },
        PEER,
      ),
    ).rejects.toThrow(/unsupported fields/);
    expect(deps.claimed).toHaveLength(0);
    expect(deps.applied).toHaveLength(0);
  });
});
