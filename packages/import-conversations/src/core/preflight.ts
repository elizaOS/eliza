/**
 * Import admission control — the quota + size preflight that gates a
 * conversation import BEFORE any parse/redact/store work runs.
 *
 * The cloud policy for #12071 (carried into #13432) requires that a large
 * import is checked against a conservative upload ceiling and the tenant's
 * quota up front, and that an over-limit import is refused *whole* rather than
 * truncated into a partial "healthy-looking" result. This module is the pure
 * decision layer the importer route/service calls: it takes an import's cost
 * estimate (upload byte size + declared counts) and returns either an admit
 * decision — including whether the transport must switch to the resumable-chunk
 * path — or a fail-fast typed rejection carrying the crossed limit and the
 * observed value, so the failure/retry UX can render an exact reason.
 *
 * It never mutates or clamps the estimate: refusing is the only over-limit
 * outcome. A malformed estimate throws (programmer error), while a legitimate
 * over-quota condition returns an explicit typed rejection rather than throwing.
 */

import { renderConversation } from "./render.ts";
import type { ConversationBundle } from "./types.ts";

/** Bytes in one mebibyte — ceilings below read in MiB for legibility. */
const MiB = 1024 * 1024;
const UTF8_ENCODER = new TextEncoder();

/** Configurable size ceilings for an import upload. */
export interface ImportLimits {
  /** Largest upload admitted in a single (non-resumable) request. */
  maxDirectUploadBytes: number;
  /**
   * Hard ceiling for the whole import. Uploads between `maxDirectUploadBytes`
   * and this value are admitted only on the resumable-chunk path; anything
   * larger is refused outright.
   */
  maxResumableUploadBytes: number;
}

/**
 * Conservative defaults applied when a caller omits explicit limits.
 * `maxDirectUploadBytes` is deliberately small so an ordinary export uploads in
 * one request; the 1 GiB hard ceiling matches the "100MB–1GB imports require
 * resumable chunks" contract in #13432.
 */
export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxDirectUploadBytes: 25 * MiB,
  maxResumableUploadBytes: 1024 * MiB,
};

/**
 * The tenant/app quota an import is charged against. Each field is the amount
 * *remaining* at preflight time; the import is admitted only if its estimate
 * fits within every field the caller supplies. Omit a field to leave that
 * dimension unbounded for this check.
 */
export interface TenantImportQuota {
  /** Remaining derived-document storage budget, in bytes. */
  remainingStorageBytes?: number;
  /** Remaining embedding budget, in embedding units (see {@link ImportUsageEstimate}). */
  remainingEmbeddingUnits?: number;
  /** Remaining number of conversations the tenant may import. */
  remainingConversations?: number;
}

/** The cost of an import, measured or estimated from its upload metadata. */
export interface ImportUsageEstimate {
  /** Raw upload size in bytes — drives the size-ceiling checks. */
  uploadBytes: number;
  /** Number of conversations in the export, when the client declares it. */
  conversationCount?: number;
  /**
   * Estimated derived-document storage in bytes. Defaults to `uploadBytes`
   * (rendered transcripts are the same order of magnitude as the raw export).
   */
  storageBytes?: number;
  /**
   * Estimated embedding units the import will consume. One unit ≈ one embedded
   * document chunk; callers that know their chunking supply this directly.
   */
  embeddingUnits?: number;
}

/** Why an import was refused. Stable codes so failure DTOs/UX can branch on them. */
export type PreflightRejectionCode =
  | "upload_too_large"
  | "quota_storage_exceeded"
  | "quota_embedding_exceeded"
  | "quota_conversations_exceeded";

/** A refused import: the crossed `limit` and the `observed` value that crossed it. */
export interface PreflightRejection {
  ok: false;
  code: PreflightRejectionCode;
  /** Human-readable summary; branch on `code`, not this string. */
  message: string;
  limit: number;
  observed: number;
}

/** An admitted import, plus whether the transport must switch to resumable chunks. */
export interface PreflightAdmit {
  ok: true;
  /**
   * True when the upload exceeds `maxDirectUploadBytes` (but is within the
   * resumable ceiling): the caller MUST use the resumable-chunk transport.
   */
  requiresResumable: boolean;
  /** The estimate the decision was made against (echoed for logging). */
  estimate: ImportUsageEstimate;
}

export type PreflightResult = PreflightAdmit | PreflightRejection;

/** Options for {@link preflightImport}; both fall back to conservative defaults. */
export interface PreflightOptions {
  /** Size ceilings; defaults to {@link DEFAULT_IMPORT_LIMITS}. */
  limits?: ImportLimits;
  /** Tenant budget; when absent, only the size ceilings apply. */
  quota?: TenantImportQuota;
}

function reject(
  code: PreflightRejectionCode,
  message: string,
  limit: number,
  observed: number,
): PreflightRejection {
  return { ok: false, code, message, limit, observed };
}

function assertNonNegativeFinite(
  value: number | undefined,
  field: keyof ImportUsageEstimate,
): void {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `preflightImport: ${field} must be a non-negative finite number, got ${value}`,
    );
  }
}

/**
 * Decide whether an import may proceed. Checks the size ceilings first (a
 * too-large upload is refused before any quota math), then each supplied tenant
 * budget dimension. Returns an admit decision — with `requiresResumable` set
 * when the upload is past the direct-upload ceiling — or the first typed
 * rejection encountered.
 *
 * Throws only on a malformed estimate (negative/non-finite byte count): an
 * unmeasured import must never be silently admitted.
 */
export function preflightImport(
  estimate: ImportUsageEstimate,
  options: PreflightOptions = {},
): PreflightResult {
  const limits = options.limits ?? DEFAULT_IMPORT_LIMITS;
  const quota = options.quota;

  assertNonNegativeFinite(estimate.uploadBytes, "uploadBytes");
  assertNonNegativeFinite(estimate.storageBytes, "storageBytes");
  assertNonNegativeFinite(estimate.embeddingUnits, "embeddingUnits");
  assertNonNegativeFinite(estimate.conversationCount, "conversationCount");

  if (estimate.uploadBytes > limits.maxResumableUploadBytes) {
    return reject(
      "upload_too_large",
      `import upload of ${estimate.uploadBytes} bytes exceeds the ${limits.maxResumableUploadBytes}-byte ceiling`,
      limits.maxResumableUploadBytes,
      estimate.uploadBytes,
    );
  }

  const storageBytes = estimate.storageBytes ?? estimate.uploadBytes;
  if (
    quota?.remainingStorageBytes !== undefined &&
    storageBytes > quota.remainingStorageBytes
  ) {
    return reject(
      "quota_storage_exceeded",
      `import needs ${storageBytes} storage bytes but only ${quota.remainingStorageBytes} remain in quota`,
      quota.remainingStorageBytes,
      storageBytes,
    );
  }

  if (
    quota?.remainingEmbeddingUnits !== undefined &&
    estimate.embeddingUnits !== undefined &&
    estimate.embeddingUnits > quota.remainingEmbeddingUnits
  ) {
    return reject(
      "quota_embedding_exceeded",
      `import needs ${estimate.embeddingUnits} embedding units but only ${quota.remainingEmbeddingUnits} remain in quota`,
      quota.remainingEmbeddingUnits,
      estimate.embeddingUnits,
    );
  }

  if (
    quota?.remainingConversations !== undefined &&
    estimate.conversationCount !== undefined &&
    estimate.conversationCount > quota.remainingConversations
  ) {
    return reject(
      "quota_conversations_exceeded",
      `import has ${estimate.conversationCount} conversations but only ${quota.remainingConversations} remain in quota`,
      quota.remainingConversations,
      estimate.conversationCount,
    );
  }

  return {
    ok: true,
    requiresResumable: estimate.uploadBytes > limits.maxDirectUploadBytes,
    estimate,
  };
}

/**
 * Derive a usage estimate from an already-parsed bundle for the post-parse cost
 * gate (the dry-run plan re-checks quota once real counts are known). Storage
 * is the byte length of the rendered transcript parts that the importer writes;
 * one embedding unit is charged per non-empty message as a conservative chunk
 * proxy. `uploadBytes` still comes from the transport and is passed through
 * unchanged.
 */
export function estimateBundleUsage(
  bundle: ConversationBundle,
  uploadBytes: number,
): ImportUsageEstimate {
  let storageBytes = 0;
  let embeddingUnits = 0;
  for (const conversation of bundle.conversations) {
    for (const part of renderConversation(conversation, bundle.source)) {
      storageBytes += byteLength(part.text);
    }
    for (const message of conversation.messages) {
      const text = message.text ?? "";
      if (text.trim().length > 0) {
        embeddingUnits += 1;
      }
    }
  }
  return {
    uploadBytes,
    conversationCount: bundle.conversations.length,
    storageBytes,
    embeddingUnits,
  };
}

function byteLength(text: string): number {
  return UTF8_ENCODER.encode(text).byteLength;
}
