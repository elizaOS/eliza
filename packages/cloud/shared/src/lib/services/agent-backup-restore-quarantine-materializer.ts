/**
 * Executes one private Agent materializer frame under exact PRIMARY quarantine
 * authority. The caller owns the private root/session authority; a success is
 * only the worker receipt, never candidate-ledger commit, boot or publication.
 * Do not invoke from another transaction already holding restore authority locks.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  AGENT_BACKUP_RESTORE_V3_MATERIALIZER_LIMITS,
  type AgentBackupRestoreV3MaterializerRequest,
  AgentBackupRestoreV3MaterializerRequestSchema,
  type AgentBackupRestoreV3OperationControl,
  canonicalizeAgentBackupRestoreV3MaterializerReceipt,
} from "@elizaos/shared";
import {
  type ReserveAgentBackupRestoreTargetAndStartReplacementIntentInput,
  withAgentBackupRestoreQuarantineAuthority,
} from "../../db/repositories/agent-backup-restore-operations";
import { buildExactRestoreQuarantineMaterializerCommand } from "./docker-sandbox-provider";
import { DockerSSHClient } from "./docker-ssh";

function invalid(): never {
  throw new ElizaError("Restore materializer request does not match its exact authority", {
    code: "AGENT_BACKUP_RESTORE_QUARANTINE_MATERIALIZER_INVALID",
  });
}

export async function executeAgentBackupRestoreQuarantineMaterializer(
  input: Readonly<{
    enabled: boolean;
    authority: ReserveAgentBackupRestoreTargetAndStartReplacementIntentInput;
    control: Readonly<AgentBackupRestoreV3OperationControl>;
    request: AgentBackupRestoreV3MaterializerRequest;
    payload: Uint8Array;
  }>,
): Promise<Readonly<{ status: "disabled" } | { status: "materialized"; receiptDigest: string }>> {
  if (input.enabled !== true) return Object.freeze({ status: "disabled" });
  const request = AgentBackupRestoreV3MaterializerRequestSchema.parse(input.request);
  const requestControl = Object.freeze({
    signal: input.control.signal,
    deadlineEpochMs: Math.min(input.control.deadlineEpochMs, request.deadlineEpochMs),
  });
  if (
    !(input.payload instanceof Uint8Array) ||
    input.payload.byteLength > AGENT_BACKUP_RESTORE_V3_MATERIALIZER_LIMITS.payloadBytes ||
    input.payload.byteLength !==
      (request.method === "stageRecord" ? request.receipt.payloadBytes : 0)
  )
    invalid();
  const payload = Buffer.from(input.payload);
  try {
    if (
      request.method === "stageRecord" &&
      createHash("sha256").update(payload).digest("hex") !== request.receipt.payloadSha256
    )
      invalid();
    const expectedDigest = createHash("sha256")
      .update(canonicalizeAgentBackupRestoreV3MaterializerReceipt(request))
      .digest("hex");
    return await withAgentBackupRestoreQuarantineAuthority(
      input.authority,
      requestControl,
      async (authority, control) => {
        const { operation, locator, target } = authority;
        if (
          request.session.restoreAttemptId !== operation.restore_attempt_id ||
          request.session.operationId !== operation.expected_operation_id ||
          request.session.expectedManifestSha256 !== operation.expected_manifest_sha256 ||
          !operation.expected_container_id ||
          !operation.expected_image_reference ||
          !operation.expected_image_platform_digest ||
          !locator.nodeHostname ||
          !locator.nodeSshPort ||
          !locator.nodeHostKeyFingerprint ||
          !locator.nodeSshUser
        )
          invalid();
        const deadlineEpochMs = Math.min(control.deadlineEpochMs, request.deadlineEpochMs);
        const remainingMs = Math.min(deadlineEpochMs - Date.now(), 30_000);
        if (remainingMs <= 0)
          throw new DOMException("Restore materializer deadline expired", "AbortError");
        control.signal.throwIfAborted();
        const metadata = Buffer.from(JSON.stringify({ ...request, deadlineEpochMs }));
        let frame: Buffer | undefined;
        try {
          if (metadata.byteLength > AGENT_BACKUP_RESTORE_V3_MATERIALIZER_LIMITS.metadataBytes)
            invalid();
          frame = Buffer.alloc(4 + metadata.byteLength + payload.byteLength);
          frame.writeUInt32BE(metadata.byteLength);
          metadata.copy(frame, 4);
          payload.copy(frame, 4 + metadata.byteLength);
          const command = buildExactRestoreQuarantineMaterializerCommand({
            agentId: operation.agent_id,
            replacementAttemptId: authority.attempt.id,
            containerId: operation.expected_container_id,
            exactRestore: {
              restoreAttemptId: operation.restore_attempt_id,
              target,
              imageReference: operation.expected_image_reference,
              imageDigest: target.imageDigest,
              imagePlatformDigest: operation.expected_image_platform_digest,
              quarantine: true,
            },
          });
          const ssh = DockerSSHClient.createDedicated(
            locator.nodeHostname,
            locator.nodeSshPort,
            locator.nodeHostKeyFingerprint,
            locator.nodeSshUser,
          );
          try {
            await ssh.execStdinAbortable(
              command,
              frame,
              AbortSignal.any([control.signal, AbortSignal.timeout(remainingMs)]),
              remainingMs,
              expectedDigest,
            );
          } finally {
            await ssh.disconnect();
          }
          return Object.freeze({ status: "materialized" as const, receiptDigest: expectedDigest });
        } finally {
          metadata.fill(0);
          frame?.fill(0);
        }
      },
    );
  } finally {
    payload.fill(0);
  }
}
