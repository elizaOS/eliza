/**
 * Prepares the exact restore execution host by joining durable create and start.
 * Provider ambiguity stops before start; successful creation is reloaded under
 * a new PRIMARY claim before the existing quarantine-only effect. Returning a
 * running host does not authorize generation boot, phase advance or routing.
 */

import { ElizaError } from "@elizaos/core";
import type { AgentBackupRestoreV3OperationControl } from "@elizaos/shared";
import {
  claimAgentBackupRestoreOperation,
  releaseAgentBackupRestoreOperationClaim,
} from "../../db/repositories/agent-backup-restore-operations";
import {
  assertAgentBackupRestoreV3OperationControl,
  snapshotAgentBackupRestoreV3OperationControl,
} from "../../db/repositories/agent-backup-restore-v3-candidate-database-control";
import { startAgentBackupRestoreQuarantine } from "./agent-backup-restore-quarantine-start";
import {
  type AgentBackupRestoreQuarantinedCreateInput,
  type AgentBackupRestoreQuarantinedCreateResult,
  runAgentBackupRestoreQuarantinedCreate,
} from "./agent-backup-restore-quarantined-create-runtime";

export type AgentBackupRestoreQuarantinePreparationResult =
  | Readonly<{ status: "disabled" }>
  | Extract<AgentBackupRestoreQuarantinedCreateResult, { status: "reconciliation_required" }>
  | Readonly<{
      status: "quarantine_running";
      operationId: string;
      replacementAttemptId: string;
      containerId: string;
      providerReceiptDigest: string;
      startReceiptDigest: string;
      createReplayed: boolean;
    }>;

/**
 * One explicit, disabled-first coordinator preparation turn using concrete
 * repositories and provider transports. Retry uses the persisted replacement,
 * never a second create after an ambiguous provider effect. A lost claim-acquire
 * acknowledgement remains fenced until that durable claim expires.
 */
export async function prepareAgentBackupRestoreQuarantine(
  input: Readonly<{
    enabled: boolean;
    create: Readonly<AgentBackupRestoreQuarantinedCreateInput>;
    control: Readonly<AgentBackupRestoreV3OperationControl>;
  }>,
): Promise<AgentBackupRestoreQuarantinePreparationResult> {
  if (input.enabled !== true) return Object.freeze({ status: "disabled" });
  const control = snapshotAgentBackupRestoreV3OperationControl(input.control);
  assertAgentBackupRestoreV3OperationControl(control, "Restore quarantine preparation");
  const signal = AbortSignal.any([
    control.signal,
    ...(input.create.signal ? [input.create.signal] : []),
    AbortSignal.timeout(Math.min(control.deadlineEpochMs - Date.now(), 2_147_483_647)),
  ]);
  const create = Object.freeze({
    ...input.create,
    target: Object.freeze({ ...input.create.target }),
    signal,
  });
  const boundedControl = Object.freeze({ ...control, signal });
  const created = await runAgentBackupRestoreQuarantinedCreate(create);
  if (created.status === "reconciliation_required") return created;
  assertAgentBackupRestoreV3OperationControl(boundedControl, "Restore quarantine preparation");
  const claim = await claimAgentBackupRestoreOperation({
    operationId: create.operationId,
    ownerId: create.ownerId,
    claimMs: 60_000,
  });
  const release = () =>
    releaseAgentBackupRestoreOperationClaim({
      operationId: create.operationId,
      ownerId: create.ownerId,
      claimGeneration: claim.claimGeneration,
    });
  let running: Awaited<ReturnType<typeof startAgentBackupRestoreQuarantine>>;
  try {
    if (
      claim.operation.phase !== "container_created" ||
      claim.operation.expected_container_id !== created.containerId
    )
      throw new ElizaError("Restore quarantine target changed between create and start", {
        code: "AGENT_BACKUP_RESTORE_QUARANTINE_PREPARATION_CONFLICT",
      });
    running = await startAgentBackupRestoreQuarantine({
      enabled: true,
      authority: {
        operationId: create.operationId,
        ownerId: create.ownerId,
        claimGeneration: claim.claimGeneration,
        targetNodeRecordId: create.target.nodeRecordId,
        targetNodeId: create.target.nodeId,
        targetNodeIncarnation: create.target.nodeIncarnation,
        targetNodeHistoryId: create.target.nodeHistoryId,
        replacementAttemptId: created.replacementAttemptId,
        activationTokenSha256: create.activationTokenSha256,
        activationTokenCiphertext: create.activationTokenCiphertext,
      },
      control: boundedControl,
    });
  } catch (cause) {
    // error-policy:J2 Preserve both the effect failure and any failed claim teardown.
    try {
      await release();
    } catch (releaseError) {
      // error-policy:J2 Claim loss cannot turn an ambiguous start into success.
      throw new AggregateError(
        [cause, releaseError],
        "Restore quarantine start and claim release failed",
      );
    }
    throw cause;
  }
  await release();
  if (running.status !== "quarantine_running" || running.containerId !== created.containerId)
    throw new ElizaError("Restore quarantine start did not retain the exact created target", {
      code: "AGENT_BACKUP_RESTORE_QUARANTINE_PREPARATION_CONFLICT",
    });
  assertAgentBackupRestoreV3OperationControl(boundedControl, "Restore quarantine preparation");
  return Object.freeze({
    status: "quarantine_running",
    operationId: created.operationId,
    replacementAttemptId: created.replacementAttemptId,
    containerId: running.containerId,
    providerReceiptDigest: created.providerReceiptDigest,
    startReceiptDigest: running.receiptDigest,
    createReplayed: created.replayed,
  });
}
