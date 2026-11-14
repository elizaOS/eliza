import { createHash } from "node:crypto";
import { assertInstallActionTransition } from "./action-transition";
import {
  createDiskInventoryFingerprint,
  createInstallPlan,
  validateDiskInventory,
} from "./planner";
import type {
  AuthorizedInstallPlan,
  DiskInventory,
  InstallAuthorization,
  InstallerAction,
  InstallerActionReceipt,
  InstallJournalEntry,
  InstallPlan,
  InstallRequest,
  PartitionTableBackup,
} from "./types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validBackupDescriptor(value: unknown): value is PartitionTableBackup {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const backup = value as Record<string, unknown>;
  return (
    Object.keys(backup).length === 4 &&
    ["stableId", "storageStableId", "location"].every(
      (key) =>
        typeof backup[key] === "string" &&
        backup[key].trim().length > 0 &&
        backup[key].length <= 4096 &&
        !backup[key].includes("\0"),
    ) &&
    backup.stableId !== backup.storageStableId &&
    typeof backup.sha256 === "string" &&
    SHA256_PATTERN.test(backup.sha256)
  );
}

function actionDigest(action: InstallerAction): string {
  return sha256(JSON.stringify(action));
}

function planDigest(plan: InstallPlan | AuthorizedInstallPlan): string {
  const { planId: _planId, executable: _executable, ...body } = plan;
  if ("authorization" in body) {
    const { authorization: _authorization, ...authorizedBody } = body;
    return sha256(JSON.stringify({ ...authorizedBody, executable: false }));
  }
  return sha256(JSON.stringify({ ...body, executable: false }));
}

function assertIsoDate(name: string, value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${name} must be an exact ISO-8601 timestamp.`);
  }
  return parsed;
}

function assertPlanIntegrity(plan: InstallPlan | AuthorizedInstallPlan): void {
  if (!SHA256_PATTERN.test(plan.planId) || planDigest(plan) !== plan.planId) {
    throw new Error("Install plan digest does not match its canonical body.");
  }
}

function assertAuthorizationShape(authorization: InstallAuthorization): {
  issuedAt: number;
  expiresAt: number;
} {
  if (
    !SHA256_PATTERN.test(authorization.planId) ||
    !SHA256_PATTERN.test(authorization.inventoryFingerprint) ||
    !authorization.ownerId.trim() ||
    !authorization.nonce.trim() ||
    !authorization.credential.trim()
  ) {
    throw new Error(
      "Owner authorization identity, binding, nonce, and credential are required.",
    );
  }
  return {
    issuedAt: assertIsoDate("authorization.issuedAt", authorization.issuedAt),
    expiresAt: assertIsoDate(
      "authorization.expiresAt",
      authorization.expiresAt,
    ),
  };
}

function authorizationDigest(authorization: InstallAuthorization): string {
  return sha256(JSON.stringify(authorization));
}

function assertTargetIdentity(
  plan: InstallPlan | AuthorizedInstallPlan,
  inventory: DiskInventory,
  comparePartitionTable = true,
): void {
  validateDiskInventory(inventory);
  if (
    inventory.stableId !== plan.target.stableId ||
    inventory.path !== plan.target.path ||
    inventory.kernelDeviceIdentity !== plan.target.kernelDeviceIdentity ||
    inventory.sizeBytes !== plan.target.sizeBytes ||
    inventory.logicalSectorBytes !== plan.target.logicalSectorBytes ||
    (comparePartitionTable &&
      inventory.gptRedundancyVerified !== plan.target.gptRedundancyVerified) ||
    inventory.bootAncestryResolved !== plan.target.bootAncestryResolved ||
    inventory.hardwareIdentity.serial !== plan.target.hardwareIdentity.serial ||
    inventory.hardwareIdentity.wwn !== plan.target.hardwareIdentity.wwn ||
    inventory.hardwareIdentity.firmwarePath !==
      plan.target.hardwareIdentity.firmwarePath ||
    (comparePartitionTable &&
      inventory.hardwareIdentity.gptDiskGuid !==
        plan.target.hardwareIdentity.gptDiskGuid)
  ) {
    throw new Error("Target disk identity changed after plan authorization.");
  }
  for (const id of plan.preservedPartitionIds) {
    if (!inventory.partitions.some((partition) => partition.id === id)) {
      throw new InstallRecoveryRequiredError(
        `Preserved partition ${id} is missing.`,
      );
    }
  }
  if (inventory.currentBootSource) {
    throw new Error("Refusing to mutate the disk that booted the installer.");
  }
  if (inventory.partitions.some((partition) => partition.mounted)) {
    throw new Error(
      "Refusing to mutate a disk with a mounted partition or stacked descendant.",
    );
  }
  if (inventory.protectedReason) {
    throw new Error(`Target disk is protected: ${inventory.protectedReason}`);
  }
}

export interface InstallInventoryProvider {
  inspect(stableId: string): Promise<DiskInventory>;
}

export interface OwnerAuthorizationVerifier {
  verify(authorization: InstallAuthorization): Promise<boolean>;
}

export interface InstallJournal {
  read(planId: string): Promise<InstallJournalEntry[]>;
  append(entry: InstallJournalEntry): Promise<void>;
}

export interface PrivilegedInstallOperations {
  backupPartitionTable(inventory: DiskInventory): Promise<PartitionTableBackup>;
  /** Reopen and verify the exact saved bytes/digest and immutable target/storage
   * binding. Current partition layout may already differ from the original. */
  verifyPartitionTableBackup(
    backup: PartitionTableBackup,
    inventory: DiskInventory,
  ): Promise<boolean>;
  apply(
    action: InstallerAction,
    inventory: DiskInventory,
  ): Promise<InstallerActionReceipt>;
}

export interface InstallExecutionDependencies {
  /** Stop at operation boundaries; never race an in-flight backend write. */
  signal?: AbortSignal;
  inventory: InstallInventoryProvider;
  authorization: OwnerAuthorizationVerifier;
  journal: InstallJournal;
  operations: PrivilegedInstallOperations;
  /** Trusted service hook used in each final pre-write revalidation sequence. */
  beforePrivilegedMutation?: (
    kind: "partition-table-backup" | "installer-action",
  ) => Promise<void>;
  now?: () => Date;
}

export interface InstallExecutionResult {
  planId: string;
  completedActions: number;
  finalInventoryFingerprint: string;
}

export class InstallRecoveryRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallRecoveryRequiredError";
  }
}

export async function authorizeInstallPlan(
  request: InstallRequest,
  plan: InstallPlan,
  authorization: InstallAuthorization,
  dependencies: Pick<
    InstallExecutionDependencies,
    "inventory" | "authorization" | "now" | "signal"
  >,
): Promise<AuthorizedInstallPlan> {
  dependencies.signal?.throwIfAborted();
  assertPlanIntegrity(plan);
  if (plan.executable !== false) {
    throw new Error("Only a non-executable reviewed plan can be authorized.");
  }
  const inventory = await dependencies.inventory.inspect(plan.target.stableId);
  assertTargetIdentity(plan, inventory);
  const recreated = createInstallPlan(request, inventory);
  if (recreated.planId !== plan.planId) {
    throw new Error(
      "Install plan is stale against the current disk inventory.",
    );
  }
  const fingerprint = createDiskInventoryFingerprint(inventory);
  if (
    authorization.planId !== plan.planId ||
    authorization.inventoryFingerprint !== fingerprint
  ) {
    throw new Error(
      "Owner authorization is not bound to this plan and inventory.",
    );
  }
  const { issuedAt, expiresAt } = assertAuthorizationShape(authorization);
  const now = (dependencies.now ?? (() => new Date()))().getTime();
  if (issuedAt > now || expiresAt <= now || expiresAt <= issuedAt) {
    throw new Error("Owner authorization is not currently valid.");
  }
  if (!(await dependencies.authorization.verify(authorization))) {
    throw new Error("Owner authorization credential verification failed.");
  }
  dependencies.signal?.throwIfAborted();
  return { ...plan, executable: true, authorization };
}

function journalEntryDigest(
  entry: Omit<InstallJournalEntry, "digest">,
): string {
  return sha256(JSON.stringify(entry));
}

function validateJournal(planId: string, entries: InstallJournalEntry[]): void {
  let previousDigest: string | null = null;
  let phase: "authorization" | "backup" | "actions" = "authorization";
  let completedActions = 0;
  let pendingActionDigest: string | undefined;
  let terminal = false;
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (
      entry.schemaVersion !== 1 ||
      entry.planId !== planId ||
      entry.sequence !== index ||
      entry.previousDigest !== previousDigest
    ) {
      throw new InstallRecoveryRequiredError(
        "Install journal sequence or identity is invalid.",
      );
    }
    const { digest, ...body } = entry;
    if (!SHA256_PATTERN.test(digest) || journalEntryDigest(body) !== digest) {
      throw new InstallRecoveryRequiredError(
        "Install journal digest chain verification failed.",
      );
    }
    const timestamp = Date.parse(entry.timestamp);
    if (
      !SHA256_PATTERN.test(entry.inventoryFingerprint) ||
      !Number.isFinite(timestamp) ||
      new Date(timestamp).toISOString() !== entry.timestamp ||
      timestamp < previousTimestamp
    ) {
      throw new InstallRecoveryRequiredError(
        "Install journal checkpoint metadata is invalid.",
      );
    }
    if (terminal) {
      throw new InstallRecoveryRequiredError(
        "Install journal contains records after a terminal event.",
      );
    }
    if (
      entry.event !== "partition-table-backup-verified" &&
      entry.partitionTableBackup !== undefined
    ) {
      throw new InstallRecoveryRequiredError(
        "Install journal backup descriptor is on the wrong event.",
      );
    }
    const hasActionFields =
      entry.actionIndex !== undefined || entry.actionDigest !== undefined;
    switch (entry.event) {
      case "authorized":
        if (
          phase !== "authorization" ||
          hasActionFields ||
          !SHA256_PATTERN.test(entry.receiptId ?? "")
        ) {
          throw new InstallRecoveryRequiredError(
            "Install journal authorization event is out of order or malformed.",
          );
        }
        phase = "backup";
        break;
      case "partition-table-backup-verified":
        if (
          phase !== "backup" ||
          hasActionFields ||
          !validBackupDescriptor(entry.partitionTableBackup) ||
          entry.receiptId !== entry.partitionTableBackup.sha256 ||
          entry.inventoryFingerprint !== entries[0]?.inventoryFingerprint
        ) {
          throw new InstallRecoveryRequiredError(
            "Install journal partition-table backup event is out of order or malformed.",
          );
        }
        phase = "actions";
        break;
      case "action-started":
        if (
          phase !== "actions" ||
          pendingActionDigest !== undefined ||
          entry.actionIndex !== completedActions ||
          !SHA256_PATTERN.test(entry.actionDigest ?? "") ||
          entry.receiptId !== undefined
        ) {
          throw new InstallRecoveryRequiredError(
            "Install journal action start is out of order or malformed.",
          );
        }
        pendingActionDigest = entry.actionDigest;
        break;
      case "action-completed":
        if (
          pendingActionDigest === undefined ||
          entry.actionIndex !== completedActions ||
          entry.actionDigest !== pendingActionDigest ||
          !entry.receiptId?.trim()
        ) {
          throw new InstallRecoveryRequiredError(
            "Install journal action completion is out of order or malformed.",
          );
        }
        completedActions += 1;
        pendingActionDigest = undefined;
        break;
      case "execution-failed":
        if (
          pendingActionDigest === undefined ||
          entry.actionIndex !== completedActions ||
          entry.actionDigest !== pendingActionDigest ||
          entry.receiptId !== undefined
        ) {
          throw new InstallRecoveryRequiredError(
            "Install journal failure event is out of order or malformed.",
          );
        }
        terminal = true;
        break;
      case "execution-completed":
        if (
          phase !== "actions" ||
          pendingActionDigest !== undefined ||
          hasActionFields ||
          entry.receiptId !== undefined
        ) {
          throw new InstallRecoveryRequiredError(
            "Install journal completion event is out of order or malformed.",
          );
        }
        terminal = true;
        break;
    }
    previousDigest = digest;
    previousTimestamp = timestamp;
  }
}

async function appendDurably(
  journal: InstallJournal,
  planId: string,
  entries: InstallJournalEntry[],
  body: Omit<
    InstallJournalEntry,
    "schemaVersion" | "planId" | "sequence" | "previousDigest" | "digest"
  >,
): Promise<InstallJournalEntry[]> {
  const unsigned = {
    schemaVersion: 1 as const,
    planId,
    sequence: entries.length,
    ...body,
    previousDigest: entries.at(-1)?.digest ?? null,
  };
  const entry = { ...unsigned, digest: journalEntryDigest(unsigned) };
  await journal.append(entry);
  const persisted = await journal.read(planId);
  validateJournal(planId, persisted);
  if (persisted.at(-1)?.digest !== entry.digest) {
    throw new InstallRecoveryRequiredError(
      "Install journal append was not durably observed.",
    );
  }
  return persisted;
}

function completedActionCount(
  plan: AuthorizedInstallPlan,
  entries: InstallJournalEntry[],
): number {
  const completed = entries.filter(
    (entry) => entry.event === "action-completed",
  );
  for (let index = 0; index < completed.length; index += 1) {
    const entry = completed[index];
    if (
      entry.actionIndex !== index ||
      entry.actionDigest !==
        actionDigest(plan.actions[index] as InstallerAction)
    ) {
      throw new InstallRecoveryRequiredError(
        "Install journal action history is not a completed plan prefix.",
      );
    }
  }
  const started = entries.filter((entry) => entry.event === "action-started");
  if (started.length !== completed.length) {
    throw new InstallRecoveryRequiredError(
      "An install action started without a durable completion receipt.",
    );
  }
  for (let index = 0; index < started.length; index += 1) {
    const entry = started[index];
    if (
      entry.actionIndex !== index ||
      entry.actionDigest !==
        actionDigest(plan.actions[index] as InstallerAction)
    ) {
      throw new InstallRecoveryRequiredError(
        "Install journal start history is not a planned action prefix.",
      );
    }
  }
  if (entries.some((entry) => entry.event === "execution-failed")) {
    throw new InstallRecoveryRequiredError(
      "The prior install attempt failed and requires explicit recovery.",
    );
  }
  return completed.length;
}

export async function executeAuthorizedInstallPlan(
  plan: AuthorizedInstallPlan,
  dependencies: InstallExecutionDependencies,
): Promise<InstallExecutionResult> {
  dependencies.signal?.throwIfAborted();
  assertPlanIntegrity(plan);
  if (plan.executable !== true) {
    throw new Error("Install plan has not been authorized for execution.");
  }
  if (plan.authorization.planId !== plan.planId) {
    throw new Error("Owner authorization is bound to a different plan.");
  }
  assertAuthorizationShape(plan.authorization);
  const now = dependencies.now ?? (() => new Date());
  if (
    assertIsoDate("authorization.expiresAt", plan.authorization.expiresAt) <=
      now().getTime() ||
    !(await dependencies.authorization.verify(plan.authorization))
  ) {
    throw new Error("Owner authorization expired or failed re-verification.");
  }

  let entries = await dependencies.journal.read(plan.planId);
  validateJournal(plan.planId, entries);
  if (
    entries.length > 0 &&
    (entries[0]?.event !== "authorized" ||
      entries[0].inventoryFingerprint !==
        plan.authorization.inventoryFingerprint ||
      entries[0].receiptId !== authorizationDigest(plan.authorization))
  ) {
    throw new InstallRecoveryRequiredError(
      "Install journal is not rooted in this owner authorization.",
    );
  }
  let inventory = await dependencies.inventory.inspect(plan.target.stableId);
  assertTargetIdentity(plan, inventory, false);
  let fingerprint = createDiskInventoryFingerprint(inventory);

  let recoveryBackup: PartitionTableBackup | undefined;
  const verifyRecoveryBackup = async (target: DiskInventory): Promise<void> => {
    if (!recoveryBackup || recoveryBackup.stableId !== plan.target.stableId) {
      throw new InstallRecoveryRequiredError(
        "The retained recovery backup is not bound to this target.",
      );
    }
    let verified: boolean;
    try {
      verified = await dependencies.operations.verifyPartitionTableBackup(
        { ...recoveryBackup },
        structuredClone(target),
      );
    } catch (error) {
      throw new InstallRecoveryRequiredError(
        `Recovery backup verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (verified !== true) {
      throw new InstallRecoveryRequiredError(
        "The retained partition-table recovery backup is missing, changed, or invalid.",
      );
    }
    dependencies.signal?.throwIfAborted();
  };

  const revalidateImmediatelyBeforeMutation = async (
    kind: "partition-table-backup" | "installer-action",
    expectedInventoryFingerprint: string,
  ): Promise<DiskInventory> => {
    dependencies.signal?.throwIfAborted();
    if (kind === "installer-action") await verifyRecoveryBackup(inventory);
    await dependencies.beforePrivilegedMutation?.(kind);
    if (
      assertIsoDate("authorization.expiresAt", plan.authorization.expiresAt) <=
        now().getTime() ||
      !(await dependencies.authorization.verify(plan.authorization))
    ) {
      throw new Error(
        `Owner authorization expired or failed immediately before ${kind}.`,
      );
    }

    // Inventory reproduction deliberately follows every asynchronous owner and
    // credential check. This is the final awaited operation before the backend
    // write, so drift while a session/credential provider is consulted cannot
    // reach a stale device path or kernel-device incarnation.
    const current = await dependencies.inventory.inspect(plan.target.stableId);
    assertTargetIdentity(plan, current, false);
    if (
      createDiskInventoryFingerprint(current) !== expectedInventoryFingerprint
    ) {
      throw new InstallRecoveryRequiredError(
        `Disk inventory drifted immediately before ${kind}.`,
      );
    }
    if (
      assertIsoDate("authorization.expiresAt", plan.authorization.expiresAt) <=
      now().getTime()
    ) {
      throw new Error(
        `Owner authorization expired immediately before ${kind}.`,
      );
    }
    dependencies.signal?.throwIfAborted();
    return current;
  };

  if (entries.length === 0) {
    if (fingerprint !== plan.authorization.inventoryFingerprint) {
      throw new Error("Disk inventory drifted before execution began.");
    }
    entries = await appendDurably(dependencies.journal, plan.planId, entries, {
      event: "authorized",
      timestamp: now().toISOString(),
      inventoryFingerprint: fingerprint,
      receiptId: authorizationDigest(plan.authorization),
    });
    inventory = await revalidateImmediatelyBeforeMutation(
      "partition-table-backup",
      plan.authorization.inventoryFingerprint,
    );
    fingerprint = createDiskInventoryFingerprint(inventory);
    const suppliedBackup = await dependencies.operations.backupPartitionTable(
      structuredClone(inventory),
    );
    const backup = { ...suppliedBackup };
    dependencies.signal?.throwIfAborted();
    if (
      !validBackupDescriptor(backup) ||
      backup.stableId !== inventory.stableId ||
      (await dependencies.operations.verifyPartitionTableBackup(
        { ...backup },
        structuredClone(inventory),
      )) !== true
    ) {
      throw new Error("Partition-table backup verification failed.");
    }
    entries = await appendDurably(dependencies.journal, plan.planId, entries, {
      event: "partition-table-backup-verified",
      timestamp: now().toISOString(),
      inventoryFingerprint: fingerprint,
      receiptId: backup.sha256,
      partitionTableBackup: backup,
    });
  } else if (
    !entries.some((entry) => entry.event === "partition-table-backup-verified")
  ) {
    throw new InstallRecoveryRequiredError(
      "Install journal exists without a verified partition-table backup.",
    );
  }

  const backupCheckpoint = entries.find(
    (entry) => entry.event === "partition-table-backup-verified",
  );
  if (
    !backupCheckpoint?.partitionTableBackup ||
    backupCheckpoint.partitionTableBackup.stableId !== plan.target.stableId
  ) {
    throw new InstallRecoveryRequiredError(
      "Install journal recovery backup is not bound to this target.",
    );
  }
  recoveryBackup = { ...backupCheckpoint.partitionTableBackup };
  const completed = completedActionCount(plan, entries);
  let expectedFingerprint =
    [...entries]
      .reverse()
      .find(
        (entry) =>
          entry.event === "action-completed" ||
          entry.event === "partition-table-backup-verified",
      )?.inventoryFingerprint ?? plan.authorization.inventoryFingerprint;
  if (fingerprint !== expectedFingerprint) {
    throw new InstallRecoveryRequiredError(
      "Disk inventory differs from the last durable install checkpoint.",
    );
  }
  const verifyCompletionBoundary = async (): Promise<void> => {
    await verifyRecoveryBackup(inventory);
    const current = await dependencies.inventory.inspect(plan.target.stableId);
    assertTargetIdentity(plan, current, false);
    if (createDiskInventoryFingerprint(current) !== expectedFingerprint) {
      throw new InstallRecoveryRequiredError(
        "Disk inventory drifted during final recovery verification.",
      );
    }
    dependencies.signal?.throwIfAborted();
  };
  if (entries.some((entry) => entry.event === "execution-completed")) {
    if (completed !== plan.actions.length) {
      throw new InstallRecoveryRequiredError(
        "Install journal completed before every planned action finished.",
      );
    }
    await verifyCompletionBoundary();
    return {
      planId: plan.planId,
      completedActions: completed,
      finalInventoryFingerprint: fingerprint,
    };
  }

  for (let index = completed; index < plan.actions.length; index += 1) {
    const action = plan.actions[index] as InstallerAction;
    inventory = await dependencies.inventory.inspect(plan.target.stableId);
    assertTargetIdentity(plan, inventory, false);
    fingerprint = createDiskInventoryFingerprint(inventory);
    if (fingerprint !== expectedFingerprint) {
      throw new InstallRecoveryRequiredError(
        "Disk inventory drifted immediately before a privileged action.",
      );
    }
    const digest = actionDigest(action);
    entries = await appendDurably(dependencies.journal, plan.planId, entries, {
      event: "action-started",
      timestamp: now().toISOString(),
      inventoryFingerprint: fingerprint,
      actionIndex: index,
      actionDigest: digest,
    });
    try {
      inventory = await revalidateImmediatelyBeforeMutation(
        "installer-action",
        expectedFingerprint,
      );
      fingerprint = createDiskInventoryFingerprint(inventory);
      // The backend may mutate its input object. Preserve an independent
      // pre-operation snapshot for the inventory readback comparison.
      const beforeAction = structuredClone(inventory);
      const receipt = await dependencies.operations.apply(action, inventory);
      dependencies.signal?.throwIfAborted();
      if (!receipt.receiptId.trim() || receipt.actionDigest !== digest) {
        throw new Error(
          "Privileged operation returned an invalid action receipt.",
        );
      }
      await verifyRecoveryBackup(beforeAction);
      inventory = await dependencies.inventory.inspect(plan.target.stableId);
      assertTargetIdentity(plan, inventory, false);
      try {
        assertInstallActionTransition(action, beforeAction, inventory);
      } catch (error) {
        throw new InstallRecoveryRequiredError(
          `Privileged action postcondition failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      fingerprint = createDiskInventoryFingerprint(inventory);
      expectedFingerprint = fingerprint;
      entries = await appendDurably(
        dependencies.journal,
        plan.planId,
        entries,
        {
          event: "action-completed",
          timestamp: now().toISOString(),
          inventoryFingerprint: fingerprint,
          actionIndex: index,
          actionDigest: digest,
          receiptId: receipt.receiptId,
        },
      );
    } catch (error) {
      await appendDurably(dependencies.journal, plan.planId, entries, {
        event: "execution-failed",
        timestamp: now().toISOString(),
        inventoryFingerprint: fingerprint,
        actionIndex: index,
        actionDigest: digest,
      });
      throw error;
    }
  }

  // A restart may land after the last action receipt but before the terminal
  // record. That zero-action resume must still verify the recovery artifact.
  await verifyCompletionBoundary();
  dependencies.signal?.throwIfAborted();
  entries = await appendDurably(dependencies.journal, plan.planId, entries, {
    event: "execution-completed",
    timestamp: now().toISOString(),
    inventoryFingerprint: fingerprint,
  });
  return {
    planId: plan.planId,
    completedActions: plan.actions.length,
    finalInventoryFingerprint: fingerprint,
  };
}
