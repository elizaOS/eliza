/**
 * GET /api/auth/siwe/nonce
 * Returns a one-time nonce + SIWE message parameters (EIP-4361).
 *
 * Redis is built per-request via `buildRedisClient(c.env)` rather than going
 * through the module-level `cache` singleton, which is currently disabled in
 * production (`CACHE_ENABLED=false`) because its lazy-opened socket is bound
 * to the first request's I/O context on Cloudflare Workers. This bypass is a
 * targeted hotfix; the singleton is replaced by an ALS facade in a follow-up.
 */

import { Hono } from "hono";
import { buildRedisClient } from "@/lib/cache/redis-factory";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getAppHost, getAppUrl } from "@/lib/utils/app-url";
import { logger } from "@/lib/utils/logger";
import { issueNonce } from "@/lib/utils/siwe-helpers";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * EIP-4361 `chainId` is a positive decimal integer and defines no narrower
 * bit-width. Keep the numeric API exact by accepting the full JavaScript safe
 * integer domain; larger values cannot round-trip through JSON as numbers.
 */
export const SIWE_CHAIN_ID_MIN = 1;
export const SIWE_CHAIN_ID_MAX = Number.MAX_SAFE_INTEGER;

/**
 * Canonical SIWE chain id at the nonce boundary.
 * Missing or empty defaults to Ethereum mainnet (1). Any other token must be
 * a complete ASCII decimal safe integer in [1, Number.MAX_SAFE_INTEGER] — no
 * sign, zero, fraction, hex, scientific notation, leading zeros, whitespace,
 * junk, or out-of-range values. Prefix-legal garbage must not coerce (parseInt("1e4")
 * is 1 and would bind the nonce to the wrong chain).
 */
export function parseSiweChainId(
  raw: string | undefined,
): { ok: true; chainId: number } | { ok: false } {
  if (raw === undefined || raw === "") {
    return { ok: true, chainId: 1 };
  }
  if (!/^\d+$/.test(raw)) {
    return { ok: false };
  }
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isSafeInteger(parsed) ||
    String(parsed) !== raw ||
    parsed < SIWE_CHAIN_ID_MIN ||
    parsed > SIWE_CHAIN_ID_MAX
  ) {
    return { ok: false };
  }
  return { ok: true, chainId: parsed };
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.get("/", async (c) => {
  const parsedChainId = parseSiweChainId(c.req.query("chainId"));
  if (!parsedChainId.ok) {
    return c.json(
      { error: "Invalid SIWE chainId", code: "invalid_chain_id" },
      400,
      { "Cache-Control": "no-store" },
    );
  }
  const resolvedChainId = parsedChainId.chainId;

  const redis = buildRedisClient(c.env);
  if (!redis) {
    return c.json({ error: "Nonce storage unavailable" }, 503);
  }

  const uri = getAppUrl(c.env);
  let nonce: string;
  try {
    nonce = await issueNonce(redis, { uri, chainId: resolvedChainId });
  } catch (error) {
    // error-policy:J1 boundary translation — nonce storage is an auth dependency;
    // callers should retry instead of seeing a generic internal-error shape.
    logger.warn("[AuthNonce] SIWE nonce storage unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json(
      { error: "Nonce storage unavailable", code: "nonce_storage_unavailable" },
      503,
      { "Cache-Control": "no-store", "Retry-After": "5" },
    );
  }

  return c.json(
    {
      nonce,
      domain: getAppHost(c.env),
      uri,
      chainId: resolvedChainId,
      version: "1",
      statement: "Sign in to Eliza Cloud",
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

export default app;
