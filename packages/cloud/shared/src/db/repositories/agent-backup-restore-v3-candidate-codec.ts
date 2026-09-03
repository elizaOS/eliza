/**
 * Privacy-safe command codec for the restore-v3 candidate repositories.
 *
 * PostgreSQL receives only bounded scalar metadata and SHA-256 digests. The
 * command preimages below are deliberately domain-separated and contain the
 * execution-token digest, never the bearer token or staged payload bytes.
 */

import { Buffer } from "node:buffer";
import { createHash, timingSafeEqual } from "node:crypto";
import type {
  AgentBackupRestoreV3ComponentReceipt,
  AgentBackupRestoreV3StageRecordReceipt,
} from "@elizaos/shared";

export const AGENT_BACKUP_RESTORE_V3_CANDIDATE_COMMAND_CONTEXT =
  "elizaos.agent-backup.restore-v3-candidate-command.v1" as const;

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJson[]
  | { readonly [key: string]: CanonicalJson };

function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) {
      throw new TypeError("Restore-v3 candidate command contains a non-canonical integer");
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as Readonly<Record<string, CanonicalJson>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key] as CanonicalJson)}`)
    .join(",")}}`;
}

export function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function exactDigestMatches(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function canonicalAgentBackupRestoreV3EntryMetadata(
  entry: AgentBackupRestoreV3StageRecordReceipt["entry"],
): string {
  if (entry === null) return "null";
  return canonicalJson({
    fileOffsetBytes: entry.fileOffsetBytes,
    fileSizeBytes: entry.fileSizeBytes,
    mode: entry.mode,
    mtimeMs: entry.mtimeMs,
    path: entry.path,
  });
}

export function canonicalAgentBackupRestoreV3Descriptor(
  descriptor: AgentBackupRestoreV3ComponentReceipt["descriptor"],
): string {
  return canonicalJson({
    compression: descriptor.compression,
    consistency: descriptor.consistency,
    contentKind: descriptor.contentKind,
    format: descriptor.format,
    name: descriptor.name,
  });
}

export function canonicalAgentBackupRestoreV3StageRecordReceipt(
  receipt: Readonly<AgentBackupRestoreV3StageRecordReceipt>,
): string {
  return canonicalJson({
    componentIndex: receipt.componentIndex,
    componentName: receipt.componentName,
    dataIndex: receipt.dataIndex,
    entry:
      receipt.entry === null
        ? null
        : {
            fileOffsetBytes: receipt.entry.fileOffsetBytes,
            fileSizeBytes: receipt.entry.fileSizeBytes,
            mode: receipt.entry.mode,
            mtimeMs: receipt.entry.mtimeMs,
            path: receipt.entry.path,
          },
    offsetBytes: receipt.offsetBytes,
    payloadBytes: receipt.payloadBytes,
    payloadSha256: receipt.payloadSha256,
  });
}

export function canonicalAgentBackupRestoreV3ComponentReceipt(
  receipt: Readonly<AgentBackupRestoreV3ComponentReceipt>,
): string {
  return canonicalJson({
    componentIndex: receipt.componentIndex,
    componentName: receipt.componentName,
    dataFrameCount: receipt.dataFrameCount,
    descriptor: {
      compression: receipt.descriptor.compression,
      consistency: receipt.descriptor.consistency,
      contentKind: receipt.descriptor.contentKind,
      format: receipt.descriptor.format,
      name: receipt.descriptor.name,
    },
    payloadBytes: receipt.payloadBytes,
    payloadSha256: receipt.payloadSha256,
    recordStreamContentHmacSha256: receipt.recordStreamContentHmacSha256,
  });
}

interface CandidateCommandIdentity {
  readonly candidateId: string;
  readonly cleanupOutboxId: string;
  readonly organizationId: string;
  readonly agentId: string;
  readonly backupId: string;
  readonly restoreAttemptId: string;
  readonly operationId: string;
  readonly executionTokenSha256: string;
}

interface CleanupFenceIdentity {
  readonly cleanupId: string;
  readonly ownerId: string;
  readonly generation: string;
  readonly attempt: number;
}

function candidateCommand(
  kind: string,
  identity: Readonly<CandidateCommandIdentity>,
  payload: Readonly<Record<string, CanonicalJson>>,
): string {
  return canonicalJson({
    context: AGENT_BACKUP_RESTORE_V3_CANDIDATE_COMMAND_CONTEXT,
    kind,
    identity: {
      agentId: identity.agentId,
      backupId: identity.backupId,
      candidateId: identity.candidateId,
      cleanupOutboxId: identity.cleanupOutboxId,
      executionTokenSha256: identity.executionTokenSha256,
      operationId: identity.operationId,
      organizationId: identity.organizationId,
      restoreAttemptId: identity.restoreAttemptId,
    },
    payload,
  });
}

export function computeAgentBackupRestoreV3CleanupCommandSha256(
  identity: Readonly<CandidateCommandIdentity>,
): string {
  return sha256Utf8(candidateCommand("cleanup", identity, { isolatedCandidate: true }));
}

export function computeAgentBackupRestoreV3RecordCommandSha256(
  identity: Readonly<CandidateCommandIdentity>,
  receipt: Readonly<AgentBackupRestoreV3StageRecordReceipt>,
): string {
  return sha256Utf8(
    candidateCommand("record", identity, {
      receiptSha256: sha256Utf8(canonicalAgentBackupRestoreV3StageRecordReceipt(receipt)),
    }),
  );
}

export function computeAgentBackupRestoreV3FinishCommandSha256(
  identity: Readonly<CandidateCommandIdentity>,
  receipt: Readonly<AgentBackupRestoreV3ComponentReceipt>,
): string {
  return sha256Utf8(
    candidateCommand("finish", identity, {
      receiptSha256: sha256Utf8(canonicalAgentBackupRestoreV3ComponentReceipt(receipt)),
    }),
  );
}

export function computeAgentBackupRestoreV3AbortReasonSha256(reason: "staging-failed"): string {
  return sha256Utf8(
    canonicalJson({
      context: AGENT_BACKUP_RESTORE_V3_CANDIDATE_COMMAND_CONTEXT,
      kind: "abort-reason",
      reason,
    }),
  );
}

export function computeAgentBackupRestoreV3AbortCommandSha256(
  identity: Readonly<CandidateCommandIdentity>,
  reasonSha256: string,
): string {
  return sha256Utf8(candidateCommand("abort", identity, { reasonSha256 }));
}

export function computeAgentBackupRestoreV3CleanupReceiptSha256(receipt: unknown): string {
  if (typeof receipt !== "string" || !/^[0-9a-f]{64}$/.test(receipt)) {
    throw new TypeError("cleanupReceiptSha256 must be a lowercase SHA-256 digest");
  }
  return receipt;
}

export function computeAgentBackupRestoreV3CleanupReasonSha256(reason: string): string {
  if (
    typeof reason !== "string" ||
    reason !== reason.trim() ||
    Buffer.byteLength(reason, "utf8") < 1 ||
    Buffer.byteLength(reason, "utf8") > 1024 ||
    reason.includes("\0")
  ) {
    throw new TypeError("cleanup reason must contain between 1 and 1024 trimmed UTF-8 bytes");
  }
  return sha256Utf8(
    canonicalJson({
      context: AGENT_BACKUP_RESTORE_V3_CANDIDATE_COMMAND_CONTEXT,
      kind: "cleanup-reason",
      reason,
    }),
  );
}

function cleanupFenceEvidence(
  kind: "cleanup-settle" | "cleanup-quarantine",
  fence: Readonly<CleanupFenceIdentity>,
  payload: Readonly<Record<string, CanonicalJson>>,
): string {
  return canonicalJson({
    context: AGENT_BACKUP_RESTORE_V3_CANDIDATE_COMMAND_CONTEXT,
    fence: {
      attempt: fence.attempt,
      cleanupId: fence.cleanupId,
      generation: fence.generation,
      ownerId: fence.ownerId,
    },
    kind,
    payload,
  });
}

export function computeAgentBackupRestoreV3CleanupSettlementEvidenceSha256(
  fence: Readonly<CleanupFenceIdentity>,
  cleanupReceiptSha256: string,
): string {
  const receiptSha256 = computeAgentBackupRestoreV3CleanupReceiptSha256(cleanupReceiptSha256);
  return sha256Utf8(cleanupFenceEvidence("cleanup-settle", fence, { receiptSha256 }));
}

export function computeAgentBackupRestoreV3CleanupQuarantineEvidenceSha256(
  fence: Readonly<CleanupFenceIdentity>,
  reason: string,
): string {
  const reasonSha256 = computeAgentBackupRestoreV3CleanupReasonSha256(reason);
  return sha256Utf8(cleanupFenceEvidence("cleanup-quarantine", fence, { reasonSha256 }));
}
