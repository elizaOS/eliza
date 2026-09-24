import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorizeInstallPlan,
  executeAuthorizedInstallPlan,
  type InstallExecutionDependencies,
  type InstallJournal,
  InstallRecoveryRequiredError,
} from "./executor";
import { DurableFileInstallJournal } from "./file-journal";
import {
  createDiskConfirmationToken,
  createDiskInventoryFingerprint,
  createInstallPlan,
} from "./planner";
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
const NOW = new Date("2026-08-20T04:00:00.000Z");

function disk(overrides: Partial<DiskInventory> = {}): DiskInventory {
  return {
    stableId: "wwn-0x5000c50012345678",
    path: "/dev/disk/by-id/wwn-0x5000c50012345678",
    hardwareIdentity: {
      serial: "Z4D3ABCD",
      wwn: "0x5000c50012345678",
      firmwarePath:
        "/sys/devices/pci0000:00/0000:00:17.0/ata1/host0/target0:0:0/0:0:0:0",
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
    ...overrides,
  };
}

function reviewedPlan(target: DiskInventory) {
  const request: InstallRequest = {
    mode: "erase-disk",
    targetStableId: target.stableId,
    expectedSizeBytes: target.sizeBytes,
    confirmationToken: createDiskConfirmationToken(target),
  };
  return { request, plan: createInstallPlan(request, target) };
}

function authorization(
  target: DiskInventory,
  planId: string,
): InstallAuthorization {
  return {
    planId,
    inventoryFingerprint: createDiskInventoryFingerprint(target),
    ownerId: "local-owner-1000",
    issuedAt: "2026-08-20T03:55:00.000Z",
    expiresAt: "2026-08-20T04:05:00.000Z",
    nonce: "approval-123",
    credential: "signed-local-owner-approval",
  };
}

class MemoryJournal implements InstallJournal {
  readonly entries: InstallJournalEntry[] = [];

  async read(planId: string): Promise<InstallJournalEntry[]> {
    return this.entries
      .filter((entry) => entry.planId === planId)
      .map((entry) => ({ ...entry }));
  }

  async append(entry: InstallJournalEntry): Promise<void> {
    this.entries.push({ ...entry });
  }
}

function digestAction(action: InstallerAction): string {
  return createHash("sha256").update(JSON.stringify(action)).digest("hex");
}

function rehashJournal(entries: InstallJournalEntry[]): void {
  let previousDigest: string | null = null;
  for (const [sequence, entry] of entries.entries()) {
    const body = {
      ...entry,
      sequence,
      previousDigest,
      digest: undefined,
    };
    delete body.digest;
    entry.sequence = sequence;
    entry.previousDigest = previousDigest;
    entry.digest = createHash("sha256")
      .update(JSON.stringify(body))
      .digest("hex");
    previousDigest = entry.digest;
  }
}

function requiredJournalEntry(
  entries: InstallJournalEntry[],
  index: number,
): InstallJournalEntry {
  const entry = entries[index];
  if (!entry) throw new Error(`Test journal entry ${index} is missing.`);
  return entry;
}

function dependencies(
  target: DiskInventory,
  overrides: Partial<InstallExecutionDependencies> = {},
): InstallExecutionDependencies & { journal: MemoryJournal } {
  const journal = new MemoryJournal();
  const activeJournal = overrides.journal ?? journal;
  return {
    inventory: { inspect: async () => structuredClone(target) },
    authorization: { verify: async () => true },
    operations: {
      backupPartitionTable: async (inventory) => ({
        stableId: inventory.stableId,
        storageStableId: "installer-media-123",
        location: "/run/elizaos-installer/recovery/gpt.bin",
        sha256: "a".repeat(64),
      }),
      verifyPartitionTableBackup: async () => true,
      apply: async (action) => {
        applyTestInventoryAction(target, action);
        return {
          receiptId: `receipt-${action.type}`,
          actionDigest: digestAction(action),
        };
      },
    },
    now: () => NOW,
    ...overrides,
    journal: activeJournal,
  } as InstallExecutionDependencies & { journal: MemoryJournal };
}

describe("privileged installer execution boundary", () => {
  it("authorizes an exact reviewed plan against a fresh inventory", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);

    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    expect(authorized.executable).toBe(true);
    expect(authorized.planId).toBe(plan.planId);
    expect(authorized.authorization.ownerId).toBe("local-owner-1000");
  });

  it("rejects inventory drift before authorization", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const changed = disk({ sizeBytes: 257 * GIB });

    await expect(
      authorizeInstallPlan(
        request,
        plan,
        authorization(target, plan.planId),
        dependencies(changed),
      ),
    ).rejects.toThrow(/identity changed|stale/);
  });

  it.each([
    ["serial", { serial: "Z4D3EFGH" }],
    ["WWN", { wwn: "0x5000c50087654321" }],
    ["firmware path", { firmwarePath: "/sys/devices/virtual/block/loop7" }],
    ["GPT disk GUID", { gptDiskGuid: "1539e59f-943e-47cb-b0b9-6e6175818029" }],
  ])("rejects %s drift before authorization", async (_name, identityChange) => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const changed = disk({
      hardwareIdentity: { ...target.hardwareIdentity, ...identityChange },
    });

    await expect(
      authorizeInstallPlan(
        request,
        plan,
        authorization(target, plan.planId),
        dependencies(changed),
      ),
    ).rejects.toThrow(/identity changed|stale/);
  });

  it("rejects GPT redundancy drift before authorization", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);

    await expect(
      authorizeInstallPlan(
        request,
        plan,
        authorization(target, plan.planId),
        dependencies(disk({ gptRedundancyVerified: false })),
      ),
    ).rejects.toThrow(/identity changed|stale/);
  });

  it("rejects boot ancestry drift before authorization", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);

    await expect(
      authorizeInstallPlan(
        request,
        plan,
        authorization(target, plan.planId),
        dependencies(disk({ bootAncestryResolved: false })),
      ),
    ).rejects.toThrow(/identity changed|stale/);
  });

  it("rejects a mount appearing before execution without applying an action", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );
    let appliedCount = 0;
    const targetPartition = target.partitions[0];
    if (!targetPartition) throw new Error("Test target partition is missing.");
    deps.inventory.inspect = async () =>
      disk({
        partitions: [{ ...targetPartition, mounted: true }],
      });
    deps.operations.apply = async (action) => {
      applyTestInventoryAction(target, action);
      appliedCount += 1;
      return {
        receiptId: `receipt-${action.type}`,
        actionDigest: digestAction(action),
      };
    };

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toThrow(/mounted partition/);
    expect(appliedCount).toBe(0);
  });

  it("backs up GPT, journals every action, and returns durable completion", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);
    let appliedCount = 0;
    deps.operations.apply = async (action) => {
      applyTestInventoryAction(target, action);
      appliedCount += 1;
      return {
        receiptId: `receipt-${action.type}`,
        actionDigest: digestAction(action),
      };
    };
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    const result = await executeAuthorizedInstallPlan(authorized, deps);

    expect(result.completedActions).toBe(plan.actions.length);
    expect(deps.journal.entries[0]?.event).toBe("authorized");
    expect(deps.journal.entries[1]?.event).toBe(
      "partition-table-backup-verified",
    );
    expect(
      deps.journal.entries.filter((entry) => entry.event === "action-started"),
    ).toHaveLength(plan.actions.length);
    expect(
      deps.journal.entries.filter(
        (entry) => entry.event === "action-completed",
      ),
    ).toHaveLength(plan.actions.length);
    expect(deps.journal.entries.at(-1)?.event).toBe("execution-completed");

    const resumed = await executeAuthorizedInstallPlan(authorized, deps);
    expect(resumed).toEqual(result);
    expect(appliedCount).toBe(plan.actions.length);
  });

  // Real durable journals use Linux descriptor-relative IO.
  it
    .skipIf(process.platform !== "linux")
    .each(["healthy", "missing", "corrupt"] as const)(
    "reopens a durable recovery checkpoint with a %s backup before resuming",
    async (state) => {
      const directory = await mkdtemp(join(tmpdir(), "installer-recovery-"));
      try {
        const location = join(directory, "gpt.backup");
        const artifact = Buffer.from("fixture recovery bytes, not a real GPT");
        const artifactDigest = createHash("sha256")
          .update(artifact)
          .digest("hex");
        const target = disk();
        const { request, plan } = reviewedPlan(target);
        const deps = dependencies(target);
        let checkpointInventory: DiskInventory | undefined;
        const apply = deps.operations.apply;
        deps.operations.apply = async (action, inventory) => {
          const result = await apply(action, inventory);
          checkpointInventory ??= structuredClone(target);
          return result;
        };
        deps.operations.backupPartitionTable = async (inventory) => {
          await writeFile(location, artifact, { mode: 0o600 });
          return {
            stableId: inventory.stableId,
            storageStableId: "independent-recovery-media",
            location,
            sha256: artifactDigest,
          };
        };
        const verify: typeof deps.operations.verifyPartitionTableBackup =
          async (backup, inventory) => {
            try {
              return (
                backup.stableId === inventory.stableId &&
                backup.storageStableId === "independent-recovery-media" &&
                backup.location === location &&
                createHash("sha256")
                  .update(await readFile(backup.location))
                  .digest("hex") === backup.sha256
              );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ENOENT")
                return false;
              throw error;
            }
          };
        deps.operations.verifyPartitionTableBackup = verify;
        const authorized = await authorizeInstallPlan(
          request,
          plan,
          authorization(target, plan.planId),
          deps,
        );
        await executeAuthorizedInstallPlan(authorized, deps);
        if (!checkpointInventory)
          throw new Error("Missing first completed action fixture");

        // Persist a clean checkpoint prefix, then reopen it with new objects as
        // a restarted service would. This is filesystem evidence, not a power-cut test.
        const journal = new DurableFileInstallJournal(directory);
        for (const entry of deps.journal.entries.slice(0, 4))
          await journal.append(entry);
        const restarted = dependencies(checkpointInventory, {
          journal: new DurableFileInstallJournal(directory),
        });
        let writes = 0;
        const resumeApply = restarted.operations.apply;
        restarted.operations.apply = async (action, inventory) => {
          writes += 1;
          return resumeApply(action, inventory);
        };
        restarted.operations.backupPartitionTable = async () => {
          throw new Error("Must not replace original recovery backup");
        };
        restarted.operations.verifyPartitionTableBackup = verify;
        if (state === "missing") await rm(location);
        if (state === "corrupt")
          await writeFile(location, "changed recovery bytes");
        if (state === "healthy") {
          const result = await executeAuthorizedInstallPlan(
            authorized,
            restarted,
          );
          expect(result.completedActions).toBe(plan.actions.length);
          expect(writes).toBe(plan.actions.length - 1);
          expect(
            (await journal.read(plan.planId))[1]?.partitionTableBackup,
          ).toEqual({
            stableId: target.stableId,
            storageStableId: "independent-recovery-media",
            location,
            sha256: artifactDigest,
          });
        } else {
          await expect(
            executeAuthorizedInstallPlan(authorized, restarted),
          ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
          expect(writes).toBe(0);
          expect((await journal.read(plan.planId)).at(-1)?.event).toBe(
            "execution-failed",
          );
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(["missing", "read error"])(
    "stops after an action leaves a backup %s and cannot claim completion",
    async (failure) => {
      const target = disk();
      const { request, plan } = reviewedPlan(target);
      const deps = dependencies(target);
      let available = true;
      let writes = 0;
      const apply = deps.operations.apply;
      deps.operations.verifyPartitionTableBackup = async () => {
        if (!available && failure === "read error")
          throw new Error("recovery storage I/O failure");
        return available;
      };
      deps.operations.apply = async (action, inventory) => {
        writes += 1;
        const result = await apply(action, inventory);
        available = false;
        return result;
      };
      const authorized = await authorizeInstallPlan(
        request,
        plan,
        authorization(target, plan.planId),
        deps,
      );
      await expect(
        executeAuthorizedInstallPlan(authorized, deps),
      ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
      expect(writes).toBe(1);
      expect(deps.journal.entries.at(-1)?.event).toBe("execution-failed");
      expect(
        deps.journal.entries.some(
          (entry) => entry.event === "action-completed",
        ),
      ).toBe(false);
    },
  );

  it("requires the recovery artifact when resuming after the last action but before final completion", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );
    await executeAuthorizedInstallPlan(authorized, deps);
    expect(deps.journal.entries.pop()?.event).toBe("execution-completed");
    deps.operations.verifyPartitionTableBackup = async () => false;
    deps.operations.apply = async () => {
      throw new Error("Completed actions must not replay");
    };
    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
    expect(deps.journal.entries.at(-1)?.event).toBe("action-completed");
  });

  it("rechecks inventory after asynchronous final recovery verification", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);
    deps.operations.verifyPartitionTableBackup = async () => {
      if (
        deps.journal.entries.filter(
          (entry) => entry.event === "action-completed",
        ).length === plan.actions.length
      ) {
        const partition = target.partitions[0];
        if (!partition) throw new Error("Missing completed partition fixture");
        partition.id = "changed-during-backup-verification";
      }
      return true;
    };
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );
    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toThrow(/inventory drifted/);
    expect(deps.journal.entries.at(-1)?.event).toBe("action-completed");
  });

  it("does not let a backup verifier rewrite the durable recovery descriptor", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);
    deps.operations.verifyPartitionTableBackup = async (backup) => {
      backup.location = "/changed-by-verifier";
      backup.sha256 = "f".repeat(64);
      return true;
    };
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );
    await executeAuthorizedInstallPlan(authorized, deps);
    expect(deps.journal.entries[1]?.partitionTableBackup).toMatchObject({
      location: "/run/elizaos-installer/recovery/gpt.bin",
      sha256: "a".repeat(64),
    });
  });

  it("fails closed when the journal cannot durably persist a checkpoint", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const volatileJournal: InstallJournal = {
      read: async () => [],
      append: async () => {},
    };
    const deps = dependencies(target, { journal: volatileJournal });
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
  });

  it("rechecks inventory after the durable authorization checkpoint and before GPT backup", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    let drifted = false;
    let backups = 0;
    const journal = new MemoryJournal();
    const originalAppend = journal.append.bind(journal);
    journal.append = async (entry) => {
      await originalAppend(entry);
      if (entry.event === "authorized") drifted = true;
    };
    const deps = dependencies(target, {
      journal,
      inventory: {
        inspect: async () =>
          drifted
            ? disk({ kernelDeviceIdentity: "8:16:99" })
            : structuredClone(target),
      },
    });
    deps.operations.backupPartitionTable = async (inventory) => {
      backups += 1;
      return {
        stableId: inventory.stableId,
        storageStableId: "installer-media-123",
        location: "/run/elizaos-installer/recovery/gpt.bin",
        sha256: "a".repeat(64),
      };
    };
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toThrow(/identity changed|drifted/);
    expect(backups).toBe(0);
  });

  it("rejects inventory drift while the owner credential is rechecked before GPT backup", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    let verificationCount = 0;
    let drifted = false;
    let backups = 0;
    const deps = dependencies(target, {
      authorization: {
        verify: async () => {
          verificationCount += 1;
          if (verificationCount === 3) drifted = true;
          return true;
        },
      },
      inventory: {
        inspect: async () =>
          drifted
            ? disk({ kernelDeviceIdentity: "8:16:99" })
            : structuredClone(target),
      },
    });
    deps.operations.backupPartitionTable = async (inventory) => {
      backups += 1;
      return {
        stableId: inventory.stableId,
        storageStableId: "installer-media-123",
        location: "/run/elizaos-installer/recovery/gpt.bin",
        sha256: "a".repeat(64),
      };
    };
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toThrow(/identity changed|drifted/);
    expect(backups).toBe(0);
  });

  it("rechecks inventory after the durable action-start checkpoint and before apply", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    let drifted = false;
    let applied = 0;
    const journal = new MemoryJournal();
    const originalAppend = journal.append.bind(journal);
    journal.append = async (entry) => {
      await originalAppend(entry);
      if (entry.event === "action-started") drifted = true;
    };
    const deps = dependencies(target, {
      journal,
      inventory: {
        inspect: async () =>
          drifted
            ? disk({ kernelDeviceIdentity: "8:16:99" })
            : structuredClone(target),
      },
    });
    deps.operations.apply = async (action) => {
      applyTestInventoryAction(target, action);
      applied += 1;
      return {
        receiptId: `receipt-${action.type}`,
        actionDigest: digestAction(action),
      };
    };
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toThrow(/identity changed|drifted/);
    expect(applied).toBe(0);
  });

  it("rejects inventory drift while the owner credential is rechecked before apply", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    let verificationCount = 0;
    let drifted = false;
    let applied = 0;
    const deps = dependencies(target, {
      authorization: {
        verify: async () => {
          verificationCount += 1;
          if (verificationCount === 4) drifted = true;
          return true;
        },
      },
      inventory: {
        inspect: async () =>
          drifted
            ? disk({ kernelDeviceIdentity: "8:16:99" })
            : structuredClone(target),
      },
    });
    deps.operations.apply = async (action) => {
      applyTestInventoryAction(target, action);
      applied += 1;
      return {
        receiptId: `receipt-${action.type}`,
        actionDigest: digestAction(action),
      };
    };
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toThrow(/identity changed|drifted/);
    expect(applied).toBe(0);
  });

  it("rejects a GPT backup stored on the disk being destroyed", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);
    deps.operations.backupPartitionTable = async (inventory) => ({
      stableId: inventory.stableId,
      storageStableId: inventory.stableId,
      location: "/target/recovery/gpt.bin",
      sha256: "b".repeat(64),
    });
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toThrow(/backup verification failed/);
  });

  it("re-verifies owner authorization before every mutation", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);
    let verificationCount = 0;
    let appliedCount = 0;
    deps.authorization.verify = async () => {
      verificationCount += 1;
      return verificationCount < 5;
    };
    deps.operations.apply = async (action) => {
      applyTestInventoryAction(target, action);
      appliedCount += 1;
      return {
        receiptId: `receipt-${action.type}`,
        actionDigest: digestAction(action),
      };
    };
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toThrow(/authorization expired or failed/);
    expect(appliedCount).toBe(1);
  });

  it("requires recovery after an action starts without a completion receipt", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    let attempts = 0;
    const deps = dependencies(target);
    deps.operations.apply = async () => {
      attempts += 1;
      throw new Error("injected power loss");
    };
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toThrow("injected power loss");
    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
    expect(attempts).toBe(1);
  });

  it.each([
    [
      "completion before its action start",
      (entries: InstallJournalEntry[]) => {
        const started = requiredJournalEntry(entries, 2);
        const completed = requiredJournalEntry(entries, 3);
        entries[2] = completed;
        entries[3] = started;
      },
    ],
    [
      "a legacy backup checkpoint without its recovery descriptor",
      (entries: InstallJournalEntry[]) => {
        delete requiredJournalEntry(entries, 1).partitionTableBackup;
      },
    ],
    [
      "a backup descriptor with the wrong target",
      (entries: InstallJournalEntry[]) => {
        const backup = requiredJournalEntry(entries, 1).partitionTableBackup;
        if (!backup) throw new Error("Missing test backup");
        backup.stableId = "another-physical-disk";
      },
    ],
    [
      "a backup descriptor with a different digest",
      (entries: InstallJournalEntry[]) => {
        const backup = requiredJournalEntry(entries, 1).partitionTableBackup;
        if (!backup) throw new Error("Missing test backup");
        backup.sha256 = "f".repeat(64);
      },
    ],
    [
      "a backup descriptor on an unrelated event",
      (entries: InstallJournalEntry[]) => {
        requiredJournalEntry(entries, 0).partitionTableBackup =
          requiredJournalEntry(entries, 1).partitionTableBackup;
      },
    ],
    [
      "a duplicate partition-table backup",
      (entries: InstallJournalEntry[]) => {
        entries[2] = { ...requiredJournalEntry(entries, 1) };
      },
    ],
    [
      "a mismatched action digest",
      (entries: InstallJournalEntry[]) => {
        requiredJournalEntry(entries, 3).actionDigest = "f".repeat(64);
      },
    ],
    [
      "an action receipt on a start checkpoint",
      (entries: InstallJournalEntry[]) => {
        requiredJournalEntry(entries, 2).receiptId = "impossible-early-receipt";
      },
    ],
    [
      "a record after terminal completion",
      (entries: InstallJournalEntry[]) => {
        entries.push({ ...requiredJournalEntry(entries, 0) });
      },
    ],
    [
      "a decreasing checkpoint timestamp",
      (entries: InstallJournalEntry[]) => {
        requiredJournalEntry(entries, 2).timestamp = "2026-08-20T03:59:59.000Z";
      },
    ],
  ])("rejects a validly rehashed journal with %s", async (_name, mutate) => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );
    await executeAuthorizedInstallPlan(authorized, deps);
    mutate(deps.journal.entries);
    rehashJournal(deps.journal.entries);

    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
  });

  it("rejects a plan body changed after review", async () => {
    const target = disk();
    const { request, plan } = reviewedPlan(target);
    const tampered = {
      ...plan,
      target: { ...plan.target, path: "/dev/sda" },
    };

    await expect(
      authorizeInstallPlan(
        request,
        tampered,
        authorization(target, plan.planId),
        dependencies(target),
      ),
    ).rejects.toThrow(/digest/);
  });
});

describe("installer inventory readback enforcement", () => {
  it.each([
    "no-op erase",
    "wrong geometry",
    "wrong filesystem",
    "changed GUID",
    "replaced ESP",
  ])(
    "journals failure and forbids replay after %s with a valid receipt",
    async (fault) => {
      const target = disk();
      const { request, plan } = reviewedPlan(target);
      const deps = dependencies(target);
      // Deliberately expose the same mutable object to prove the executor keeps
      // an independent pre-operation snapshot rather than trusting its backend.
      deps.inventory.inspect = async () => target;
      const apply = deps.operations.apply;
      let attempts = 0;
      deps.operations.apply = async (action, observed) => {
        attempts += 1;
        if (fault === "no-op erase") {
          return {
            receiptId: "lying-receipt",
            actionDigest: digestAction(action),
          };
        }
        const receipt = await apply(action, observed);
        if (action.type === "create-partition") {
          const added = target.partitions.at(-1);
          if (!added) throw new Error("Missing new partition fixture.");
          if (fault === "wrong geometry") added.startBytes += MIB;
          if (fault === "wrong filesystem") added.filesystem = "ntfs";
          if (fault === "changed GUID")
            target.hardwareIdentity.gptDiskGuid =
              "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
        }
        if (fault === "replaced ESP" && action.type === "install-system") {
          const esp = target.partitions.find((item) => item.role === "esp");
          if (!esp) throw new Error("Missing ESP fixture.");
          esp.id = "unexpected-esp-identity";
        }
        return receipt;
      };
      const authorized = await authorizeInstallPlan(
        request,
        plan,
        authorization(target, plan.planId),
        deps,
      );
      await expect(
        executeAuthorizedInstallPlan(authorized, deps),
      ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
      expect(deps.journal.entries.at(-1)?.event).toBe("execution-failed");
      expect(
        deps.journal.entries.some(
          (entry) => entry.event === "execution-completed",
        ),
      ).toBe(false);
      const stoppedAt = attempts;
      await expect(
        executeAuthorizedInstallPlan(authorized, deps),
      ).rejects.toBeInstanceOf(InstallRecoveryRequiredError);
      expect(attempts).toBe(stoppedAt);
    },
  );

  it("initializes GPT on a blank disk and resumes only the verified final inventory", async () => {
    const target = disk({
      partitionTable: "none",
      gptRedundancyVerified: undefined,
      hardwareIdentity: { ...disk().hardwareIdentity, gptDiskGuid: undefined },
      partitions: [],
    });
    const { request, plan } = reviewedPlan(target);
    const deps = dependencies(target);
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );
    const result = await executeAuthorizedInstallPlan(authorized, deps);
    expect(target.partitionTable).toBe("gpt");
    expect(target.hardwareIdentity.gptDiskGuid).toBeTruthy();
    expect(await executeAuthorizedInstallPlan(authorized, deps)).toEqual(
      result,
    );
    target.hardwareIdentity.gptDiskGuid =
      "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await expect(
      executeAuthorizedInstallPlan(authorized, deps),
    ).rejects.toThrow(/differs from the last durable/);
  });

  it("preserves existing partitions through a complete alongside layout", async () => {
    const target = disk();
    const preserved = structuredClone(target.partitions);
    const request: InstallRequest = {
      mode: "alongside",
      targetStableId: target.stableId,
      expectedSizeBytes: target.sizeBytes,
      confirmationToken: createDiskConfirmationToken(target),
      freeExtentId: "free",
    };
    const plan = createInstallPlan(request, target);
    const deps = dependencies(target);
    const authorized = await authorizeInstallPlan(
      request,
      plan,
      authorization(target, plan.planId),
      deps,
    );
    const result = await executeAuthorizedInstallPlan(authorized, deps);
    expect(result.completedActions).toBe(plan.actions.length);
    for (const partition of preserved) {
      expect(
        target.partitions.find((item) => item.id === partition.id),
      ).toEqual(partition);
    }
  });
});
