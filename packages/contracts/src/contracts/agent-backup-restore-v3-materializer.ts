/** Private coordinator-to-Agent materializer metadata; transport ownership is required. */

import { z } from "zod";
import { AGENT_BACKUP_CAPTURE_V2_LIMITS } from "./agent-backup-capture-v2.js";
import {
  AgentBackupRestoreV3CandidateReceiptSchema,
  AgentBackupRestoreV3ComponentReceiptSchema,
  AgentBackupRestoreV3StageRecordReceiptSchema,
  AgentBackupRestoreV3StagingSessionSchema,
  canonicalizeAgentBackupRestoreV3CandidateReceipt,
  canonicalizeAgentBackupRestoreV3ComponentReceipt,
  canonicalizeAgentBackupRestoreV3StageRecordReceipt,
} from "./agent-backup-restore-v3-stream.js";

// Bounds protocol metadata and one raw record, never model-facing content.
export const AGENT_BACKUP_RESTORE_V3_MATERIALIZER_LIMITS = Object.freeze({
  metadataBytes: 8 * 1024 * 1024,
  payloadBytes: AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes,
});
const IdentitySchema = z.strictObject({
  device: z.string().regex(/^(0|[1-9][0-9]*)$/),
  inode: z.string().regex(/^[1-9][0-9]*$/),
});
const authority = {
  version: z.literal(2),
  trustedRoot: z.string().min(1).max(4096),
  attemptRoot: z.string().min(1).max(4096),
  trustedRootIdentity: IdentitySchema,
  attemptRootIdentity: IdentitySchema,
  session: AgentBackupRestoreV3StagingSessionSchema,
  deadlineEpochMs: z.number().int().safe().positive(),
};
export const AgentBackupRestoreV3MaterializerRequestSchema =
  z.discriminatedUnion("method", [
    z.strictObject({
      ...authority,
      method: z.literal("stageRecord"),
      receipt: AgentBackupRestoreV3StageRecordReceiptSchema,
    }),
    z.strictObject({
      ...authority,
      method: z.literal("finishComponent"),
      receipt: AgentBackupRestoreV3ComponentReceiptSchema,
    }),
    z.strictObject({
      ...authority,
      method: z.literal("assembleCandidate"),
      receipt: AgentBackupRestoreV3CandidateReceiptSchema,
    }),
  ]);
export type AgentBackupRestoreV3MaterializerRequest = z.infer<
  typeof AgentBackupRestoreV3MaterializerRequestSchema
>;

/** Canonical receipt bytes whose SHA-256 is the worker's only success response. */
export function canonicalizeAgentBackupRestoreV3MaterializerReceipt(
  request: AgentBackupRestoreV3MaterializerRequest,
): string {
  switch (request.method) {
    case "stageRecord":
      return canonicalizeAgentBackupRestoreV3StageRecordReceipt(
        request.receipt,
      );
    case "finishComponent":
      return canonicalizeAgentBackupRestoreV3ComponentReceipt(request.receipt);
    case "assembleCandidate":
      return canonicalizeAgentBackupRestoreV3CandidateReceipt(request.receipt);
  }
}
