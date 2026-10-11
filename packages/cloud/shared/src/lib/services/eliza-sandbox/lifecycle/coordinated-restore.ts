/**
 * Production admission of a manifest-v3 restore into the restore coordinator
 * (#20732). The API call only acquires the restore lease and opens the durable
 * operation; the coordinator worker performs every container effect and moves
 * the agent's route only after a signed boot attestation and probes.
 */

import { ElizaError } from "@elizaos/core";
import { hasAgentBackupRestoreAuthority } from "../../../../db/repositories/agent-backup-restore-authority";
import type {
  AgentSandbox,
  StoredAgentSandboxBackup,
} from "../../../../db/schemas/agent-sandboxes";
import { logger } from "../../../utils/logger";
import { beginAgentBackupRestore } from "../../agent-backup-restore-admission";
import { readAgentBackupRestoreCoordinatorConfig } from "../../agent-backup-restore-coordinator-runtime";
import type { SnapshotResult } from "../backup/contracts";

export const COORDINATED_RESTORE_IN_PROGRESS = "Another restore of this backup is in progress";

/**
 * Returns null when the coordinator is disabled or the backup is not a
 * catalogued manifest-v3 backup, leaving the legacy restore path in charge.
 * A catalogued backup that is not restorable is refused explicitly rather than
 * silently downgraded to the legacy path.
 */
export async function admitCoordinatedAgentBackupRestore(
  sandbox: Readonly<Pick<AgentSandbox, "id" | "organization_id">>,
  backup: Readonly<StoredAgentSandboxBackup>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SnapshotResult | null> {
  const config = readAgentBackupRestoreCoordinatorConfig(env);
  if (!config.enabled || backup.manifest_version !== 3) return null;
  if (
    backup.catalog_organization_id !== sandbox.organization_id ||
    backup.catalog_agent_id !== sandbox.id ||
    !backup.backup_operation_id ||
    !backup.lifecycle_generation ||
    backup.lifecycle_revision === null ||
    !backup.manifest_digest
  ) {
    return { success: false, error: "No backup found", refusal: "not-found" };
  }
  if (!hasAgentBackupRestoreAuthority(backup.catalog_state)) {
    return {
      success: false,
      error: "Backup is not in a restorable catalogue state",
      refusal: "conflict",
    };
  }
  let begun: Awaited<ReturnType<typeof beginAgentBackupRestore>>;
  try {
    begun = await beginAgentBackupRestore({
      config,
      backup: {
        organizationId: sandbox.organization_id,
        backupId: backup.id,
        backupOperationId: backup.backup_operation_id,
        sourceActivationGeneration: backup.lifecycle_generation,
        sourceLifecycleRevision: backup.lifecycle_revision.toString(),
        manifestSha256: backup.manifest_digest,
      },
    });
  } catch (error) {
    // error-policy:J3 a restore owned by another coordinator is a conflict the
    // caller can act on, not a server fault; every other failure propagates.
    if (error instanceof ElizaError && error.code === "AGENT_BACKUP_RESTORE_ALREADY_IN_PROGRESS") {
      return { success: false, error: COORDINATED_RESTORE_IN_PROGRESS, refusal: "conflict" };
    }
    throw error;
  }
  logger.info("[AgentBackupRestoreCoordinator] Restore admitted", {
    agentId: sandbox.id,
    organizationId: sandbox.organization_id,
    backupId: backup.id,
    operationId: begun.operationId,
    replayed: begun.replayed,
  });
  return {
    success: true,
    restoreOperation: {
      operationId: begun.operationId,
      restoreAttemptId: begun.restoreAttemptId,
      backupId: backup.id,
      phase: begun.phase,
      replayed: begun.replayed,
    },
  };
}
