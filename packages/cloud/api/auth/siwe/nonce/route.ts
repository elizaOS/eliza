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

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.get("/", async (c) => {
  const chainIdRaw = c.req.query("chainId") ?? "1";
  const chainId = Number.parseInt(chainIdRaw, 10);

  const redis = buildRedisClient(c.env);
  if (!redis) {
    return c.json({ error: "Nonce storage unavailable" }, 503);
  }

  const uri = getAppUrl(c.env);
  const resolvedChainId = Number.isNaN(chainId) ? 1 : chainId;
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
