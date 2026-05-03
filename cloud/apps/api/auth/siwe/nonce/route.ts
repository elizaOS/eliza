/**
 * GET /api/auth/siwe/nonce
 * Returns a one-time nonce + SIWE message parameters (EIP-4361).
 */

import { Hono } from "hono";
import { cache } from "@/lib/cache/client";
import { CacheKeys, CacheTTL } from "@/lib/cache/keys";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { getAppHost, getAppUrl } from "@/lib/utils/app-url";
import type { AppEnv } from "@/types/cloud-worker-env";

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.get("/", async (c) => {
  const chainIdRaw = c.req.query("chainId") ?? "1";
  const chainId = Number.parseInt(chainIdRaw, 10);

  if (!cache.isAvailable()) {
    return c.json({ error: "Nonce storage unavailable" }, 503);
  }

  const nonce = randomHex(16);
  await cache.set(CacheKeys.siwe.nonce(nonce), nonce, CacheTTL.siwe.nonce);

  return c.json(
    {
      nonce,
      domain: getAppHost(),
      uri: getAppUrl(),
      chainId: Number.isNaN(chainId) ? 1 : chainId,
      version: "1",
      statement: "Sign in to Eliza Cloud",
    },
    200,
    { "Cache-Control": "no-store" },
  );
});

export default app;
