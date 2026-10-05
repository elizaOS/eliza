/**
 * Admission of one manifest-v3 restore into the restore coordinator (#20732).
 * The API path acquires the restore lease for the coordinator's identity and
 * opens the durable operation; it never touches Docker, storage or KMS. This
 * module deliberately stays free of the coordinator's effect graph so the
 * request path only loads repository authority.
 */

import { randomUUID } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import { and, eq, notInArray } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { acquireAgentBackupRestoreLease } from "../../db/repositories/agent-backup-restore-lease";
import { openAgentBackupRestoreOperation } from "../../db/repositories/agent-backup-restore-operations";
import {
  type AgentBackupRestoreOperation,
  type AgentBackupRestorePhase,
  agentBackupRestoreOperations,
} from "../../db/schemas/agent-backup-catalog";
import type { AgentBackupRestoreEnabledCoordinatorConfig } from "./agent-backup-restore-coordinator-runtime";

/** Each coordinator turn renews the restore lease to this window. */
export const AGENT_BACKUP_RESTORE_COORDINATOR_LEASE_MS = 3_600_000;

export interface BeginAgentBackupRestoreResult {
  readonly operationId: string;
  readonly restoreAttemptId: string;
  readonly phase: AgentBackupRestorePhase;
  /** True when a restore of this backup was already in progress. */
  readonly replayed: boolean;
}

/** The single open (non-terminal) restore of one backup, from the primary. */
export async function findOpenAgentBackupRestoreOperation(
  organizationId: string,
  backupId: string,
): Promise<Readonly<AgentBackupRestoreOperation> | null> {
  const [row] = await dbWrite
    .select()
    .from(agentBackupRestoreOperations)
    .where(
      and(
        eq(agentBackupRestoreOperations.organization_id, organizationId),
        eq(agentBackupRestoreOperations.backup_id, backupId),
        notInArray(agentBackupRestoreOperations.phase, ["finalized", "failed_terminal"]),
      ),
    )
    .limit(1);
  return row ? Object.freeze(row) : null;
}

/**
 * Acquire the restore lease and open the durable operation. A concurrent
 * request for the same backup replays the in-progress restore instead of
 * starting a second one.
 */
export async function beginAgentBackupRestore(input: {
  config: AgentBackupRestoreEnabledCoordinatorConfig;
  backup: Readonly<{
    organizationId: string;
    backupId: string;
    backupOperationId: string;
    sourceActivationGeneration: string;
    sourceLifecycleRevision: string;
    manifestSha256: string;
  }>;
  dependencies?: Partial<{
    acquire: typeof acquireAgentBackupRestoreLease;
    open: typeof openAgentBackupRestoreOperation;
    findOpen: typeof findOpenAgentBackupRestoreOperation;
    randomUuid: () => string;
  }>;
}): Promise<BeginAgentBackupRestoreResult> {
  const acquire = input.dependencies?.acquire ?? acquireAgentBackupRestoreLease;
  const open = input.dependencies?.open ?? openAgentBackupRestoreOperation;
  const findOpen = input.dependencies?.findOpen ?? findOpenAgentBackupRestoreOperation;
  const inProgress = async (): Promise<BeginAgentBackupRestoreResult | null> => {
    const existing = await findOpen(input.backup.organizationId, input.backup.backupId);
    if (!existing) return null;
    if (existing.lease_owner_id !== input.config.workerId) {
      throw new ElizaError("Another restore coordinator owns this backup's restore", {
        code: "AGENT_BACKUP_RESTORE_ALREADY_IN_PROGRESS",
        severity: "ephemeral",
      });
    }
    return Object.freeze({
      operationId: existing.id,
      restoreAttemptId: existing.restore_attempt_id,
      phase: existing.phase,
      replayed: true,
    });
  };
  // A restore already running for this backup is reported, never duplicated.
  const running = await inProgress();
  if (running) return running;
  const restoreAttemptId = (input.dependencies?.randomUuid ?? randomUUID)();
  let acquired: Awaited<ReturnType<typeof acquireAgentBackupRestoreLease>>;
  try {
    acquired = await acquire({
      organizationId: input.backup.organizationId,
      backupId: input.backup.backupId,
      operationId: input.backup.backupOperationId,
      sourceActivationGeneration: input.backup.sourceActivationGeneration,
      sourceLifecycleRevision: input.backup.sourceLifecycleRevision,
      expectedManifestSha256: input.backup.manifestSha256,
      copyRole: "primary",
      restoreAttemptId,
      ownerId: input.config.workerId,
      leaseMs: AGENT_BACKUP_RESTORE_COORDINATOR_LEASE_MS,
    });
  } catch (error) {
    // error-policy:J3 a concurrent admission may have won the lease; report
    // its restore instead of failing the caller, otherwise keep the failure.
    const concurrent = await inProgress();
    if (concurrent) return concurrent;
    throw error;
  }
  if (acquired.authority.ownerId !== input.config.workerId) {
    throw new ElizaError("Another restore coordinator owns this backup's restore", {
      code: "AGENT_BACKUP_RESTORE_ALREADY_IN_PROGRESS",
      severity: "ephemeral",
    });
  }
  const opened = await open({ authority: acquired.authority, leaseId: acquired.lease.id });
  return Object.freeze({
    operationId: opened.operation.id,
    restoreAttemptId: opened.operation.restore_attempt_id,
    phase: opened.operation.phase,
    replayed: acquired.status === "active" || opened.replayed,
  });
}
