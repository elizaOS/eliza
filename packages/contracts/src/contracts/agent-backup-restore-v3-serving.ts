/**
 * Private coordinator-to-Agent contract for turning a sealed restore candidate
 * into a served runtime. It covers the one-shot controller methods run inside
 * the exact restore container, the boot grant, and the signed boot/probe
 * attestations. Every attestation is an HMAC-SHA256 under the per-restore
 * activation token, so only the process that received the grant can sign it.
 * This module carries no database, provider, filesystem or network dependency.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  AgentBackupRestoreV3CandidateReceiptSchema,
  AgentBackupRestoreV3StagingSessionSchema,
} from "./agent-backup-restore-v3-stream.js";

export const AGENT_BACKUP_RESTORE_V3_SERVING_LIMITS = Object.freeze({
  requestBytes: 4 * 1024 * 1024,
  responseBytes: 64 * 1024,
});

/** Container paths are fixed by convention; the coordinator never supplies free-form paths. */
export const AGENT_BACKUP_RESTORE_V3_CONTAINER_DATA_ROOT = "/app/data";

const Uuid = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    "must be a canonical lowercase UUID",
  );
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const ContainerId = z.string().regex(/^[0-9a-f]{64}$/);
const Nonce = z.string().regex(/^[0-9a-f]{64}$/);
const TokenBase64Url = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const Deadline = z.number().int().safe().positive();
export const AgentBackupRestoreV3FsIdentitySchema = z.strictObject({
  device: z.string().regex(/^(0|[1-9][0-9]*)$/),
  inode: z.string().regex(/^[1-9][0-9]*$/),
});
export type AgentBackupRestoreV3FsIdentity = z.infer<
  typeof AgentBackupRestoreV3FsIdentitySchema
>;

/** Deterministic private roots of one restore attempt inside its container. */
export interface AgentBackupRestoreV3ContainerRoots {
  readonly trustedRoot: string;
  readonly attemptRoot: string;
  readonly generationTrustedRoot: string;
  readonly generationRoot: string;
  readonly runtimeRoot: string;
}

export function agentBackupRestoreV3ContainerRoots(
  restoreAttemptId: string,
): AgentBackupRestoreV3ContainerRoots {
  const attempt = Uuid.parse(restoreAttemptId);
  const base = `${AGENT_BACKUP_RESTORE_V3_CONTAINER_DATA_ROOT}/.restore-v3`;
  return Object.freeze({
    trustedRoot: `${base}/candidate/${attempt}`,
    attemptRoot: `${base}/candidate/${attempt}/attempt`,
    generationTrustedRoot: `${base}/generation/${attempt}`,
    generationRoot: `${base}/generation/${attempt}/attempt`,
    runtimeRoot: `${base}/runtime/${attempt}`,
  });
}

export const AgentBackupRestoreV3RootIdentitiesSchema = z.strictObject({
  trustedRootIdentity: AgentBackupRestoreV3FsIdentitySchema,
  attemptRootIdentity: AgentBackupRestoreV3FsIdentitySchema,
  generationTrustedRootIdentity: AgentBackupRestoreV3FsIdentitySchema,
  generationRootIdentity: AgentBackupRestoreV3FsIdentitySchema,
  runtimeRootIdentity: AgentBackupRestoreV3FsIdentitySchema,
});
export type AgentBackupRestoreV3RootIdentities = z.infer<
  typeof AgentBackupRestoreV3RootIdentitiesSchema
>;

const ControllerAuthority = {
  version: z.literal(1),
  agentId: Uuid,
  restoreAttemptId: Uuid,
  deadlineEpochMs: Deadline,
};

/** Committed-generation handoff the coordinator persists and replays verbatim. */
export const AgentBackupRestoreV3CommittedGenerationSchema = z.strictObject({
  preparedReceipt: z.record(z.string(), z.unknown()),
  preparedReceiptSha256: Sha256Hex,
  committedReceiptSha256: Sha256Hex,
  runtimeRootIdentity: AgentBackupRestoreV3FsIdentitySchema,
  generationTrustedRootIdentity: AgentBackupRestoreV3FsIdentitySchema,
  generationRootIdentity: AgentBackupRestoreV3FsIdentitySchema,
});
export type AgentBackupRestoreV3CommittedGeneration = z.infer<
  typeof AgentBackupRestoreV3CommittedGenerationSchema
>;

export const AgentBackupRestoreV3BootGrantSchema = z.strictObject({
  version: z.literal(1),
  format: z.literal("elizaos.agent-backup.restore-v3-boot-grant.v1"),
  agentId: Uuid,
  organizationId: Uuid,
  restoreAttemptId: Uuid,
  containerId: ContainerId,
  nodeIncarnation: Uuid,
  generation: AgentBackupRestoreV3CommittedGenerationSchema,
  token: TokenBase64Url,
  tokenSha256: Sha256Hex,
});
export type AgentBackupRestoreV3BootGrant = z.infer<
  typeof AgentBackupRestoreV3BootGrantSchema
>;

export const AgentBackupRestoreV3ControllerRequestSchema = z.discriminatedUnion(
  "method",
  [
    z.strictObject({
      ...ControllerAuthority,
      method: z.literal("prepareRoots"),
    }),
    z.strictObject({
      ...ControllerAuthority,
      method: z.literal("commitGeneration"),
      roots: AgentBackupRestoreV3RootIdentitiesSchema,
      session: AgentBackupRestoreV3StagingSessionSchema,
      receipt: AgentBackupRestoreV3CandidateReceiptSchema,
    }),
    z.strictObject({
      ...ControllerAuthority,
      method: z.literal("writeBootGrant"),
      grant: AgentBackupRestoreV3BootGrantSchema,
    }),
  ],
);
export type AgentBackupRestoreV3ControllerRequest = z.infer<
  typeof AgentBackupRestoreV3ControllerRequestSchema
>;

export const AgentBackupRestoreV3ControllerResponseSchema =
  z.discriminatedUnion("method", [
    z.strictObject({
      method: z.literal("prepareRoots"),
      roots: AgentBackupRestoreV3RootIdentitiesSchema,
    }),
    z.strictObject({
      method: z.literal("commitGeneration"),
      generation: AgentBackupRestoreV3CommittedGenerationSchema,
    }),
    z.strictObject({
      method: z.literal("writeBootGrant"),
      grantSha256: Sha256Hex,
    }),
  ]);
export type AgentBackupRestoreV3ControllerResponse = z.infer<
  typeof AgentBackupRestoreV3ControllerResponseSchema
>;

/** Probe request written to the restored runtime's private socket. */
export const AgentBackupRestoreV3ProbeRequestSchema = z.strictObject({
  version: z.literal(1),
  restoreAttemptId: Uuid,
  nonce: Nonce,
});
export type AgentBackupRestoreV3ProbeRequest = z.infer<
  typeof AgentBackupRestoreV3ProbeRequestSchema
>;

export const AgentBackupRestoreV3AttestationBodySchema = z.strictObject({
  version: z.literal(1),
  format: z.literal("elizaos.agent-backup.restore-v3-runtime-attestation.v1"),
  agentId: Uuid,
  organizationId: Uuid,
  restoreAttemptId: Uuid,
  containerId: ContainerId,
  nodeIncarnation: Uuid,
  committedReceiptSha256: Sha256Hex,
  tokenSha256: Sha256Hex,
  nonce: Nonce,
  /** Runtime was initialized from the committed generation and answers on PORT. */
  runtimeReady: z.literal(true),
  listenPort: z.number().int().min(1).max(65535),
  characterName: z.string().min(1).max(512),
});
export type AgentBackupRestoreV3AttestationBody = z.infer<
  typeof AgentBackupRestoreV3AttestationBodySchema
>;

export const AgentBackupRestoreV3AttestationSchema = z.strictObject({
  body: AgentBackupRestoreV3AttestationBodySchema,
  mac: Sha256Hex,
});
export type AgentBackupRestoreV3Attestation = z.infer<
  typeof AgentBackupRestoreV3AttestationSchema
>;

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot encode a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function canonicalizeAgentBackupRestoreV3ServingValue(
  value: unknown,
): string {
  return canonicalJson(value);
}

function tokenBytes(token: string): Buffer {
  const bytes = Buffer.from(TokenBase64Url.parse(token), "base64url");
  if (bytes.byteLength !== 32) {
    throw new TypeError("Restore activation token must be 32 bytes");
  }
  return bytes;
}

/** SHA-256 hex of the raw token bytes, matching `activation_token_hash`. */
export function agentBackupRestoreV3TokenSha256(token: string): string {
  const bytes = tokenBytes(token);
  try {
    return createHash("sha256").update(bytes).digest("hex");
  } finally {
    bytes.fill(0);
  }
}

export function signAgentBackupRestoreV3Attestation(
  token: string,
  body: AgentBackupRestoreV3AttestationBody,
): AgentBackupRestoreV3Attestation {
  const parsed = AgentBackupRestoreV3AttestationBodySchema.parse(body);
  const key = tokenBytes(token);
  try {
    const mac = createHmac("sha256", key)
      .update(canonicalJson(parsed))
      .digest("hex");
    return Object.freeze({ body: parsed, mac });
  } finally {
    key.fill(0);
  }
}

/** Constant-time verification; returns the parsed body only for an exact MAC. */
export function verifyAgentBackupRestoreV3Attestation(
  token: string,
  value: unknown,
): AgentBackupRestoreV3AttestationBody | null {
  const parsed = AgentBackupRestoreV3AttestationSchema.safeParse(value);
  if (!parsed.success) return null;
  const expected = signAgentBackupRestoreV3Attestation(token, parsed.data.body);
  const left = Buffer.from(expected.mac, "hex");
  const right = Buffer.from(parsed.data.mac, "hex");
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
    ? parsed.data.body
    : null;
}
