/**
 * Low-level cache + invalidation for the inference hot path (#9899).
 *
 * This module is intentionally dependency-light - it imports ONLY the cache
 * layer (no auth / api-key / moderation services) so that the mutation sites
 * that must invalidate the cache (api-keys, admin) can import it without
 * creating an import cycle with the resolver in `inference-auth-context.ts`.
 *
 * The `InferenceAuthContext` (IAC) entry collapses auth + org + moderation into
 * a single KV read for API-key dedicated-agent inference. Two hard rules make it
 * safe (see `packages/cloud-api/docs/inference-hot-path.md`):
 *   1. A positive entry is ONLY ever written for a FULLY-authorized credential
 *      (active user + active org + not suspended + org present). There are no
 *      `active`/`suspended` booleans in the shape - anything not-OK is simply
 *      not cached, so the route falls back to the authoritative chain and the
 *      exact 401/403/402 taxonomy is preserved.
 *   2. Entries are keyed by the FULL sha256(key) (== the stored `key_hash`), so
 *      revoke/ban invalidation by `key_hash` is exact.
 */

import { createHash } from "node:crypto";
import { cache } from "../cache/client";
import { CacheKeys, CacheTTL } from "../cache/keys";
import { logger } from "../utils/logger";

/** Current IAC schema version. Bump the key suffix in CacheKeys on a breaking change. */
export const INFERENCE_AUTH_CONTEXT_VERSION = 1 as const;

/**
 * A cached, fully-authorized inference identity. Presence of this entry means
 * the credential was active + org-active + not-suspended at populate time.
 */
export interface InferenceAuthContext {
  v: typeof INFERENCE_AUTH_CONTEXT_VERSION;
  cachedAt: number;
  userId: string;
  orgId: string;
  apiKeyId: string;
  /** Full sha256(presented key) - equals the stored api_keys.key_hash. */
  keyHash: string;
}

/** Org credit-balance snapshot used ONLY as the optimistic-billing fast-path gate hint. */
export interface OrgBalanceHint {
  v: typeof INFERENCE_AUTH_CONTEXT_VERSION;
  orgId: string;
  balanceUsd: number;
  balanceAt: number;
}

/** Full sha256 of a presented API key - matches how `api_keys.key_hash` is stored. */
export function hashApiKey(rawKey: string): string {
  return createHash("sha256").update(rawKey).digest("hex");
}

/**
 * Runtime shape guard. Rejects legacy / wrong-version / partial entries so a
 * malformed value can never be trusted as an authorization decision.
 */
export function isInferenceAuthContext(value: unknown): value is InferenceAuthContext {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === INFERENCE_AUTH_CONTEXT_VERSION &&
    typeof v.cachedAt === "number" &&
    typeof v.userId === "string" &&
    v.userId.length > 0 &&
    typeof v.orgId === "string" &&
    v.orgId.length > 0 &&
    typeof v.apiKeyId === "string" &&
    v.apiKeyId.length > 0 &&
    typeof v.keyHash === "string" &&
    v.keyHash.length > 0
  );
}

export function isOrgBalanceHint(value: unknown): value is OrgBalanceHint {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.v === INFERENCE_AUTH_CONTEXT_VERSION &&
    typeof v.orgId === "string" &&
    v.orgId.length > 0 &&
    typeof v.balanceUsd === "number" &&
    Number.isFinite(v.balanceUsd) &&
    typeof v.balanceAt === "number"
  );
}

/**
 * Read the cached IAC for a presented key hash. Returns null on miss, on a
 * shape-invalid entry (which is then dropped), or when the cache is unavailable.
 * Never throws and never fabricates a context.
 */
export async function readInferenceAuthContext(
  keyHash: string,
): Promise<InferenceAuthContext | null> {
  const key = CacheKeys.inference.authContext(keyHash);
  const cached = await cache.get<unknown>(key);
  if (cached === null) return null;
  if (!isInferenceAuthContext(cached)) {
    logger.warn("[InferenceAuthCache] Dropping malformed IAC entry", { key });
    await cache.del(key);
    return null;
  }
  return cached;
}

/** Write a fully-authorized IAC entry. Callers MUST only pass authorized identities. */
export async function writeInferenceAuthContext(ctx: InferenceAuthContext): Promise<void> {
  await cache.set(
    CacheKeys.inference.authContext(ctx.keyHash),
    ctx,
    CacheTTL.inference.authContext,
  );
}

/**
 * Exact invalidation by the stored `key_hash`. Called from every api-key
 * mutation (revoke/update/delete/deactivate) so a revoked key stops fast-pathing
 * immediately rather than waiting out the TTL.
 */
export async function invalidateInferenceAuthContextByKeyHash(keyHash: string): Promise<void> {
  await cache.del(CacheKeys.inference.authContext(keyHash));
}

/**
 * Fan-out invalidation for every supplied key hash (used at ban / deactivate,
 * where the caller resolves the user's key hashes from the DB). Best-effort.
 */
export async function invalidateInferenceAuthContextsByKeyHashes(
  keyHashes: readonly string[],
): Promise<void> {
  if (keyHashes.length === 0) return;
  await Promise.all(keyHashes.map((h) => cache.del(CacheKeys.inference.authContext(h))));
}

export async function readOrgBalanceHint(orgId: string): Promise<OrgBalanceHint | null> {
  const cached = await cache.get<unknown>(CacheKeys.inference.orgBalance(orgId));
  if (cached === null) return null;
  if (!isOrgBalanceHint(cached)) {
    await cache.del(CacheKeys.inference.orgBalance(orgId));
    return null;
  }
  return cached;
}

export async function writeOrgBalanceHint(
  orgId: string,
  balanceUsd: number,
  balanceAt: number,
): Promise<void> {
  const hint: OrgBalanceHint = {
    v: INFERENCE_AUTH_CONTEXT_VERSION,
    orgId,
    balanceUsd,
    balanceAt,
  };
  await cache.set(CacheKeys.inference.orgBalance(orgId), hint, CacheTTL.inference.orgBalance);
}

/** Drop the org-balance gate hint so the next request re-reads it fresh. */
export async function invalidateOrgBalanceHint(orgId: string): Promise<void> {
  await cache.del(CacheKeys.inference.orgBalance(orgId));
}
