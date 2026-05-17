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
import { issueSiwsNonce } from "@/lib/utils/siws-helpers";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.get("/", async (c) => {
  const chainId = c.req.query("chainId") ?? "solana:mainnet";

  const redis = buildRedisClient(c.env);
  if (!redis) {
    return c.json({ error: "Nonce storage unavailable" }, 503);
  }

  const nonce = await issueSiwsNonce(redis);

  return c.json(
    {
      nonce,
      domain: getAppHost(c.env),
      uri: getAppUrl(c.env),
      chainId,
      version: "1",
      statement: "Sign in to Eliza Cloud",
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

export default app;
