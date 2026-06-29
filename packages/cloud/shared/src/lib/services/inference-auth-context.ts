/**
 * Inference hot-path auth resolver (#9899).
 *
 * `resolveInferenceAuthContext(req)` collapses the pre-forward auth + org +
 * moderation chain into a SINGLE KV read for API-key dedicated-agent inference.
 * On a cache miss it runs the existing authoritative chain exactly once, then
 * caches the result for the next request.
 *
 * Scope: ONLY `X-API-Key` / `Bearer eliza_*` credentials are eligible. Wallet
 * (signature/timestamp-bound, fail-closed), Bearer-JWT, and cookie sessions are
 * NOT cacheable (no invalidation path / replay risk) and always take the
 * authoritative slow path. See `packages/cloud/api/docs/inference-hot-path.md`.
 *
 * Safety invariants:
 *   - A positive IAC entry is written ONLY for a fully-authorized credential.
 *   - Auth failures (invalid/inactive/no-org) throw from the authoritative chain
 *     and propagate unchanged -> the route maps them to the exact 401/403.
 *   - No try/catch returns a synthesized context. Cache-unavailable -> slow path,
 *     never fail-open.
 */

import { requireAuthOrApiKeyWithOrg } from "../auth";
import { cache } from "../cache/client";
import { apiKeysService } from "./api-keys";
import { contentModerationService } from "./content-moderation";
import {
  hashApiKey,
  INFERENCE_AUTH_CONTEXT_VERSION,
  type InferenceAuthContext,
  readInferenceAuthContext,
  writeInferenceAuthContext,
} from "./inference-auth-cache";

export type { InferenceAuthContext } from "./inference-auth-cache";

/**
 * Discriminated resolution outcome.
 *   - `authorized`: proceed; the route uses ctx and SKIPS auth + moderation.
 *   - `suspended`: the route returns the 403 account-suspended response.
 *   - `slow_path`: the route runs the existing authoritative chain verbatim
 *     (non-API-key credential, or cache backend unavailable).
 */
export type InferenceAuthResolution =
  | { kind: "authorized"; ctx: InferenceAuthContext; source: "cache" | "origin" }
  | { kind: "suspended"; userId: string }
  | { kind: "slow_path"; reason: "non_api_key" | "cache_unavailable" };

/**
 * Extract a cacheable API-key credential from the request, mirroring the
 * precedence of `requireAuthOrApiKey`. Returns null when the request is not
 * eligible for the fast path (wallet headers present, or no API key).
 */
export function extractApiKeyCredential(req: Request): string | null {
  // Wallet auth is fail-closed and replay-protected - never cache it.
  if (
    req.headers.get("X-Wallet-Address") &&
    req.headers.get("X-Wallet-Signature") &&
    req.headers.get("X-Timestamp")
  ) {
    return null;
  }

  const xApiKey = req.headers.get("X-API-Key");
  if (xApiKey && xApiKey.trim().length > 0) return xApiKey.trim();

  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) {
    const token = auth.slice(7).trim();
    // Only `eliza_*` bearer tokens are API keys (matches requireAuthOrApiKey).
    if (token.startsWith("eliza_")) return token;
  }

  return null;
}

export async function resolveInferenceAuthContext(req: Request): Promise<InferenceAuthResolution> {
  const rawKey = extractApiKeyCredential(req);
  if (!rawKey) return { kind: "slow_path", reason: "non_api_key" };

  // The fast path depends on the shared KV cache. If it is unavailable (circuit
  // open / disabled / no backend), take the authoritative slow path - correct,
  // just slower. Invalidation only works against the bound KV namespace, so we
  // never run the fast path on a degraded backend (see doc CS-5).
  if (!cache.isAvailable()) return { kind: "slow_path", reason: "cache_unavailable" };

  const keyHash = hashApiKey(rawKey);

  const cached = await readInferenceAuthContext(keyHash);
  if (cached) {
    // Preserve the api-key usage tracking the slow path performs (fire-and-forget).
    void apiKeysService.incrementUsageDebounced(cached.apiKeyId);
    return { kind: "authorized", ctx: cached, source: "cache" };
  }

  // Miss: run the authoritative chain ONCE. Throws (invalid/inactive/no-org)
  // propagate to the route's catch and map to the exact 401/403 unchanged.
  const { user, apiKey } = await requireAuthOrApiKeyWithOrg(req);

  // Only API-key auth is cacheable. If precedence resolved a non-API-key
  // identity for some reason, do not cache - let the route slow-path it.
  if (!apiKey) return { kind: "slow_path", reason: "non_api_key" };

  if (await contentModerationService.shouldBlockUser(user.id)) {
    // Do NOT cache a suspended decision; the route returns 403 and the next
    // request re-checks authoritatively.
    return { kind: "suspended", userId: user.id };
  }

  const ctx: InferenceAuthContext = {
    v: INFERENCE_AUTH_CONTEXT_VERSION,
    cachedAt: Date.now(),
    userId: user.id,
    orgId: user.organization_id,
    apiKeyId: apiKey.id,
    keyHash,
  };
  await writeInferenceAuthContext(ctx);
  return { kind: "authorized", ctx, source: "origin" };
}
