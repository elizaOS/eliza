/**
 * Shared→Dedicated memory transfer wire contract, round 3 (#20923 spec,
 * #21090 architecture review).
 *
 * The transfer is a fenced, epoch-bound promotion rather than a best-effort
 * copy:
 *
 * 1. The SOURCE (Shared runtime) opens a promotion epoch for the scope. The
 *    epoch is server-bound: while it is `fenced`, the Shared runtime refuses
 *    memory writes for that scope, so the snapshot cannot race a writer.
 * 2. The export runs inside the fence and produces a SIGNED whole-export seal
 *    binding {epoch, scope, row count, order-sensitive digest, vector
 *    dimension}. The signature key never travels with the payload.
 * 3. The DESTINATION stages batches without making them visible, verifying
 *    each batch chains to the seal it references.
 * 4. Finalization is ONE atomic step: the staged set is re-verified against
 *    the ORIGINAL whole-export seal (signature included), scaffolding and row
 *    visibility are published in the same transaction, and the epoch is
 *    marked promoted. A failed finalize leaves nothing visible.
 * 5. Vector dimensions are negotiated explicitly: the seal declares the
 *    dimension; a destination without a matching column refuses with a typed
 *    error instead of re-embedding or silently dropping.
 */

import { z } from "zod";

export const SHARED_MEMORY_TRANSFER_MAX_ROWS = 500;

/** Epoch lifecycle: open → fenced → promoted | aborted. */
export const PromotionEpochStateSchema = z.enum([
  "open",
  "fenced",
  "promoted",
  "aborted",
]);
export type PromotionEpochState = z.infer<typeof PromotionEpochStateSchema>;

export const SealedMemoryExportRowSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  created_at: z.string().datetime(),
  content: z.record(z.string(), z.unknown()),
  entity_id: z.string().uuid().nullable(),
  agent_id: z.string().uuid(),
  room_id: z.string().uuid().nullable(),
  world_id: z.string().uuid().nullable(),
  unique: z.boolean(),
  metadata: z.record(z.string(), z.unknown()),
  embedding: z.array(z.number()).nullable(),
});
export type SealedMemoryExportRow = z.infer<typeof SealedMemoryExportRowSchema>;

/**
 * Whole-export seal. `signature` is HMAC-SHA256 over the canonical seal body
 * (every field except `signature` itself, in the exact key order of
 * `sealSigningPayload`) with the key named by
 * `ELIZA_MEMORY_TRANSFER_SEAL_KEY`. The destination re-derives it from the
 * ORIGINAL seal on finalize; batches cannot substitute a weaker seal.
 */
export const SealedExportSealSchema = z.object({
  version: z.literal(3),
  epoch: z.number().int().positive(),
  source_agent_id: z.string().uuid(),
  scope: z.string().min(1),
  row_count: z.number().int().nonnegative(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  vector_dimension: z.number().int().positive().nullable(),
  exported_at: z.string().datetime(),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SealedExportSeal = z.infer<typeof SealedExportSealSchema>;

/** One staged batch: rows plus the seal they claim membership of. */
export const SealedMemoryStageRequestSchema = z.object({
  seal: SealedExportSealSchema,
  batch_index: z.number().int().nonnegative(),
  batch_count: z.number().int().positive(),
  rows: z
    .array(SealedMemoryExportRowSchema)
    .max(SHARED_MEMORY_TRANSFER_MAX_ROWS),
});
export type SealedMemoryStageRequest = z.infer<
  typeof SealedMemoryStageRequestSchema
>;

/** Finalize: no rows travel here — only the ORIGINAL seal to bind against. */
export const SealedMemoryFinalizeRequestSchema = z.object({
  seal: SealedExportSealSchema,
});
export type SealedMemoryFinalizeRequest = z.infer<
  typeof SealedMemoryFinalizeRequestSchema
>;

export const SealedMemoryTransferErrorCode = z.enum([
  "EPOCH_NOT_FENCED",
  "EPOCH_ALREADY_PROMOTED",
  "SEAL_SIGNATURE_INVALID",
  "SEAL_DIGEST_MISMATCH",
  "BATCH_OUT_OF_ORDER",
  "DIMENSION_UNSUPPORTED",
  "IMPORT_ID_CONFLICT",
  "STAGING_INCOMPLETE",
]);
export type SealedMemoryTransferError = z.infer<
  typeof SealedMemoryTransferErrorCode
>;

/* ------------------------------------------------------------------ */
/* Canonical hashing / signing (WebCrypto: workerd + node + bun)      */
/* ------------------------------------------------------------------ */

const encoder = new TextEncoder();

/**
 * Canonical JSON: object keys sorted recursively at every level, arrays kept
 * in order, no whitespace. Two semantically identical values always produce
 * the same bytes, so digests cannot drift on key order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Stable per-row line: identity + content hash inputs, order-sensitive. */
export function sharedMemoryRowLine(row: SealedMemoryExportRow): string {
  return [
    row.id,
    row.created_at,
    row.type,
    row.entity_id ?? "",
    row.room_id ?? "",
    row.world_id ?? "",
    JSON.stringify(row.content),
    row.embedding ? JSON.stringify(row.embedding) : "",
  ].join("|");
}

/**
 * Order-sensitive whole-export digest: sha256 over the newline-joined row
 * lines followed by the row count. Both sides recompute it from raw rows —
 * the digest is derived, never trusted from the wire.
 */
export async function computeSharedMemoryTransferDigest(
  rows: readonly SealedMemoryExportRow[],
): Promise<string> {
  const body = `${rows.map(sharedMemoryRowLine).join("\n")}\ncount:${rows.length}`;
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
}

/** Canonical signing payload — every seal field except the signature. */
export function sealSigningPayload(
  seal: Omit<SealedExportSeal, "signature">,
): string {
  return [
    `v:${seal.version}`,
    `epoch:${seal.epoch}`,
    `agent:${seal.source_agent_id}`,
    `scope:${seal.scope}`,
    `count:${seal.row_count}`,
    `digest:${seal.digest}`,
    `dim:${seal.vector_dimension ?? "none"}`,
    `at:${seal.exported_at}`,
  ].join("|");
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function signSeal(
  seal: Omit<SealedExportSeal, "signature">,
  secret: string,
): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(sealSigningPayload(seal)),
  );
  return toHex(sig);
}

/** Constant-time verification via WebCrypto's own verify. */
export async function verifySealSignature(
  seal: SealedExportSeal,
  secret: string,
): Promise<boolean> {
  const { signature, ...body } = seal;
  const key = await hmacKey(secret);
  const sigBytes = new Uint8Array(
    (signature.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)),
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    encoder.encode(sealSigningPayload(body)),
  );
}
