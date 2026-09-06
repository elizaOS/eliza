/**
 * Connects exact PRIMARY quarantine authority, durable candidate journal and
 * private Agent transport. Every guarded effect uses one transaction; SSH never
 * opens a nested coordinator transaction. Success is not a boot or route grant.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { ElizaError } from "@elizaos/core";
import {
  AGENT_BACKUP_RESTORE_V3_MATERIALIZER_LIMITS,
  AgentBackupRestoreV3CandidateReceiptSchema,
  AgentBackupRestoreV3ComponentReceiptSchema,
  type AgentBackupRestoreV3MaterializerRequest,
  AgentBackupRestoreV3MaterializerRequestSchema,
  type AgentBackupRestoreV3OperationControl,
  type AgentBackupRestoreV3SourceAuthority,
  AgentBackupRestoreV3StageRecordReceiptSchema,
  canonicalizeAgentBackupRestoreV3MaterializerReceipt,
} from "@elizaos/shared";
import {
  type ReserveAgentBackupRestoreTargetAndStartReplacementIntentInput,
  type ReserveAgentBackupRestoreTargetAndStartReplacementIntentResult,
  withAgentBackupRestoreQuarantineAuthority,
} from "../../db/repositories/agent-backup-restore-operations";
import {
  type AgentBackupRestoreV3CandidateMaterializer,
  createAgentBackupRestoreV3GuardedMaterializingCandidateExecution,
} from "../../db/repositories/agent-backup-restore-v3-candidate-execution";
import { buildExactRestoreQuarantineMaterializerCommand } from "./docker-sandbox-provider";
import { DockerSSHClient } from "./docker-ssh";

type MaterializerRoots = Pick<
  AgentBackupRestoreV3MaterializerRequest,
  "trustedRoot" | "attemptRoot" | "trustedRootIdentity" | "attemptRootIdentity"
>;

function invalid(): never {
  throw new ElizaError("Restore materializer request does not match its exact authority", {
    code: "AGENT_BACKUP_RESTORE_QUARANTINE_MATERIALIZER_INVALID",
  });
}

function prepareFrame(requestInput: AgentBackupRestoreV3MaterializerRequest, bytes: Uint8Array) {
  const request = AgentBackupRestoreV3MaterializerRequestSchema.parse(requestInput);
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > AGENT_BACKUP_RESTORE_V3_MATERIALIZER_LIMITS.payloadBytes ||
    bytes.byteLength !== (request.method === "stageRecord" ? request.receipt.payloadBytes : 0)
  )
    invalid();
  const payload = Buffer.from(bytes);
  try {
    if (
      request.method === "stageRecord" &&
      createHash("sha256").update(payload).digest("hex") !== request.receipt.payloadSha256
    )
      invalid();
    const expectedDigest = createHash("sha256")
      .update(canonicalizeAgentBackupRestoreV3MaterializerReceipt(request))
      .digest("hex");
    return { request, payload, expectedDigest };
  } catch (cause) {
    // error-policy:J2 Release owned plaintext before propagating validation failure.
    payload.fill(0);
    throw cause;
  }
}

async function sendFrame(
  authority: ReserveAgentBackupRestoreTargetAndStartReplacementIntentResult,
  control: Readonly<AgentBackupRestoreV3OperationControl>,
  prepared: ReturnType<typeof prepareFrame>,
): Promise<Readonly<{ status: "materialized"; receiptDigest: string }>> {
  const { request, payload, expectedDigest } = prepared;
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
    if (metadata.byteLength > AGENT_BACKUP_RESTORE_V3_MATERIALIZER_LIMITS.metadataBytes) invalid();
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
}

/** Standalone effect; journaled callers use the guarded execution factory below. */
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
  const prepared = prepareFrame(input.request, input.payload);
  try {
    const control = Object.freeze({
      signal: input.control.signal,
      deadlineEpochMs: Math.min(input.control.deadlineEpochMs, prepared.request.deadlineEpochMs),
    });
    return await withAgentBackupRestoreQuarantineAuthority(
      input.authority,
      control,
      (authority, bounded) => sendFrame(authority, bounded, prepared),
    );
  } finally {
    prepared.payload.fill(0);
  }
}

/** Bind one process-held candidate to its existing exact remote roots and target claim. */
export function createAgentBackupRestoreQuarantineCandidateExecution(
  input: Readonly<{
    enabled: boolean;
    sourceAuthority: Readonly<AgentBackupRestoreV3SourceAuthority>;
    authority: ReserveAgentBackupRestoreTargetAndStartReplacementIntentInput;
    roots: Readonly<MaterializerRoots>;
  }>,
) {
  if (input.enabled !== true) return Object.freeze({ status: "disabled" as const });
  const authorityInput = Object.freeze({ ...input.authority });
  const roots = Object.freeze({
    trustedRoot: input.roots.trustedRoot,
    attemptRoot: input.roots.attemptRoot,
    trustedRootIdentity: Object.freeze({ ...input.roots.trustedRootIdentity }),
    attemptRootIdentity: Object.freeze({ ...input.roots.attemptRootIdentity }),
  });
  const staging = createAgentBackupRestoreV3GuardedMaterializingCandidateExecution(
    input.sourceAuthority,
    {
      run: (control, use) =>
        withAgentBackupRestoreQuarantineAuthority(
          authorityInput,
          control,
          async (authority, bounded, transaction) => {
            const execute = async (
              request: AgentBackupRestoreV3MaterializerRequest,
              payload: Uint8Array,
              effectControl: Readonly<AgentBackupRestoreV3OperationControl>,
            ) => {
              const prepared = prepareFrame(request, payload);
              try {
                await sendFrame(authority, effectControl, prepared);
              } finally {
                prepared.payload.fill(0);
              }
            };
            const materializer: AgentBackupRestoreV3CandidateMaterializer = {
              stageRecord: async (session, record, effectControl) => {
                const receipt = AgentBackupRestoreV3StageRecordReceiptSchema.parse({
                  componentIndex: record.componentIndex,
                  componentName: record.componentName,
                  dataIndex: record.dataIndex,
                  offsetBytes: record.offsetBytes,
                  entry: record.entry,
                  payloadBytes: record.payload.byteLength,
                  payloadSha256: createHash("sha256").update(record.payload).digest("hex"),
                });
                await execute(
                  {
                    ...roots,
                    version: 2,
                    session,
                    method: "stageRecord",
                    receipt,
                    deadlineEpochMs: effectControl.deadlineEpochMs,
                  },
                  record.payload,
                  effectControl,
                );
                return receipt;
              },
              finishComponent: async (session, value, effectControl) => {
                const receipt = AgentBackupRestoreV3ComponentReceiptSchema.parse(value);
                await execute(
                  {
                    ...roots,
                    version: 2,
                    session,
                    method: "finishComponent",
                    receipt,
                    deadlineEpochMs: effectControl.deadlineEpochMs,
                  },
                  new Uint8Array(),
                  effectControl,
                );
                return receipt;
              },
              assembleCandidate: async (session, value, effectControl) => {
                const receipt = AgentBackupRestoreV3CandidateReceiptSchema.parse(value);
                await execute(
                  {
                    ...roots,
                    version: 2,
                    session,
                    method: "assembleCandidate",
                    receipt,
                    deadlineEpochMs: effectControl.deadlineEpochMs,
                  },
                  new Uint8Array(),
                  effectControl,
                );
                return receipt;
              },
            };
            return use(transaction, materializer, bounded);
          },
          { candidateJournal: true },
        ),
    },
  );
  return Object.freeze({ status: "enabled" as const, staging });
}
