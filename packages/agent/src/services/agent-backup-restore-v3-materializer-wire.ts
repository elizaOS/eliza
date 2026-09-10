/**
 * Private one-operation wire contract for a quarantined Agent materializer.
 * Stdin carries a length-prefixed JSON authority followed by raw record bytes;
 * stdin remains open as the operation's liveness channel after the frame;
 * stdout carries only the digest of the exact completed receipt. This is not
 * public authentication: the coordinator must exclusively own the transport.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { ElizaError } from "@elizaos/core";
import {
  AGENT_BACKUP_CAPTURE_V2_LIMITS,
  AgentBackupRestoreV3CandidateReceiptSchema,
  AgentBackupRestoreV3ComponentReceiptSchema,
  AgentBackupRestoreV3StageRecordReceiptSchema,
  AgentBackupRestoreV3StagingSessionSchema,
} from "@elizaos/shared";
import { z } from "zod";
import { candidateFsCanonicalJson } from "./agent-backup-restore-v3-candidate-fs-json";

// Covers the canonical receipt's 8192 bounded source-object descriptors, not
// arbitrary model context. Oversize input is rejected, never truncated.
export const MATERIALIZER_METADATA_MAX_BYTES = 8 * 1024 * 1024;
export const MATERIALIZER_PAYLOAD_MAX_BYTES =
  AGENT_BACKUP_CAPTURE_V2_LIMITS.maxFramePayloadBytes;

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
export const MaterializerRequestSchema = z.discriminatedUnion("method", [
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
export type MaterializerRequest = z.infer<typeof MaterializerRequestSchema>;

export function materializerWireError(code: string): ElizaError {
  return new ElizaError("Quarantined Agent materialization did not complete", {
    code: `AGENT_BACKUP_RESTORE_V3_MATERIALIZER_${code}`,
    severity: "fatal",
  });
}

export function materializerReceiptDigest(receipt: unknown): string {
  return createHash("sha256")
    .update(candidateFsCanonicalJson(receipt))
    .digest("hex");
}

/**
 * Owns and zeroes ingress buffers. Stops at one complete frame without closing
 * stdin: EOF means cancellation, not successful request delivery. The caller
 * must monitor the remaining stream for disconnect or forbidden trailing data.
 */
export async function readMaterializerRequest(
  input: Readable,
): Promise<{ request: MaterializerRequest; payload: Uint8Array }> {
  const prefix = Buffer.alloc(4);
  let prefixBytes = 0;
  let metadata: Buffer | undefined;
  let metadataBytes = 0;
  let payloadBytes = 0;
  let request: MaterializerRequest | undefined;
  let payload: Uint8Array | undefined;
  try {
    for await (const value of input.iterator({ destroyOnReturn: false })) {
      if (!Buffer.isBuffer(value)) throw materializerWireError("INPUT_INVALID");
      try {
        let offset = 0;
        while (offset < value.length) {
          if (prefixBytes < 4) {
            const count = Math.min(4 - prefixBytes, value.length - offset);
            value.copy(prefix, prefixBytes, offset, offset + count);
            prefixBytes += count;
            offset += count;
            if (prefixBytes === 4) {
              const length = prefix.readUInt32BE();
              if (length === 0 || length > MATERIALIZER_METADATA_MAX_BYTES)
                throw materializerWireError("INPUT_INVALID");
              metadata = Buffer.alloc(length);
            }
          } else if (metadata && metadataBytes < metadata.length) {
            const count = Math.min(
              metadata.length - metadataBytes,
              value.length - offset,
            );
            value.copy(metadata, metadataBytes, offset, offset + count);
            metadataBytes += count;
            offset += count;
            if (metadataBytes === metadata.length) {
              request = MaterializerRequestSchema.parse(
                JSON.parse(
                  new TextDecoder("utf-8", { fatal: true }).decode(metadata),
                ),
              );
              const length =
                request.method === "stageRecord"
                  ? request.receipt.payloadBytes
                  : 0;
              if (length > MATERIALIZER_PAYLOAD_MAX_BYTES)
                throw materializerWireError("INPUT_INVALID");
              payload = new Uint8Array(length);
              metadata.fill(0);
            }
          } else {
            if (
              !payload ||
              value.length - offset > payload.length - payloadBytes
            )
              throw materializerWireError("INPUT_INVALID");
            payload.set(value.subarray(offset), payloadBytes);
            payloadBytes += value.length - offset;
            offset = value.length;
          }
        }
      } finally {
        value.fill(0);
      }
      if (request && payload && payloadBytes === payload.length) {
        if (
          request.method === "stageRecord" &&
          createHash("sha256").update(payload).digest("hex") !==
            request.receipt.payloadSha256
        )
          throw materializerWireError("INPUT_INVALID");
        return { request, payload };
      }
    }
    throw materializerWireError("INPUT_INVALID");
  } catch {
    // error-policy:J1 Never expose private metadata, session tokens or parser input.
    payload?.fill(0);
    throw materializerWireError("INPUT_INVALID");
  } finally {
    prefix.fill(0);
    metadata?.fill(0);
  }
}
