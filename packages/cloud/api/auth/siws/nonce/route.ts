/**
 * GET /api/auth/siws/nonce
 * Returns a one-time SIWS nonce + Solana sign-in message parameters.
 * Mirrors siwe/nonce/route.ts; see it for the per-request Redis rationale.
 */

import { Hono } from "hono";
import { buildRedisClient } from "@/lib/cache/redis-factory";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getAppHost, getAppUrl } from "@/lib/utils/app-url";
import { logger } from "@/lib/utils/logger";
import { issueSiwsNonce } from "@/lib/utils/siws-helpers";
import type { AppEnv } from "@/types/cloud-worker-env";

/**
 * SIWS `chainId` is a CAIP-2 Solana string, not an EIP-4361 integer.
 * Missing or empty defaults to `solana:mainnet`. Any other token must be
 * `solana:` plus a 1–32 character CAIP-2 reference — no other namespace,
 * whitespace, slash, colon-in-reference, or junk. Garbage must not be
 * Redis-bound: verify later requires the signed chainId to match the
 * issued binding exactly.
 */
export const SIWS_DEFAULT_CHAIN_ID = "solana:mainnet";
const SIWS_CHAIN_ID_RE = /^solana:[a-zA-Z0-9_-]{1,32}$/;

export function parseSiwsChainId(
  raw: string | undefined,
): { ok: true; chainId: string } | { ok: false } {
  if (raw === undefined || raw === "") {
    return { ok: true, chainId: SIWS_DEFAULT_CHAIN_ID };
  }
  if (!SIWS_CHAIN_ID_RE.test(raw)) {
    return { ok: false };
  }
  return { ok: true, chainId: raw };
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.get("/", async (c) => {
  const parsedChainId = parseSiwsChainId(c.req.query("chainId"));
  if (!parsedChainId.ok) {
    return c.json(
      { error: "Invalid SIWS chainId", code: "invalid_chain_id" },
      400,
      { "Cache-Control": "no-store" },
    );
  }
  const chainId = parsedChainId.chainId;

  const redis = buildRedisClient(c.env);
  if (!redis) {
    return c.json({ error: "Nonce storage unavailable" }, 503);
  }

  const uri = getAppUrl(c.env);
  let nonce: string;
  try {
    nonce = await issueSiwsNonce(redis, { uri, chainId });
  } catch (error) {
    // error-policy:J1 boundary translation — nonce storage is an auth dependency;
    // callers should retry instead of seeing a generic internal-error shape.
    logger.warn("[AuthNonce] SIWS nonce storage unavailable", {
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
      chainId,
      version: "1",
      statement: "Sign in to Eliza Cloud",
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

export default app;
