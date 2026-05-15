/**
 * POST /api/auth/siwe/verify
 * Validates SIWE message + signature, consumes nonce, finds-or-creates
 * a user by wallet address, and issues an API key.
 *
 * Redis is built per-request — see comment in `nonce/route.ts` for why.
 */

import { Hono } from "hono";
import { getAddress } from "viem";
import { buildRedisClient } from "@/lib/cache/redis-factory";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { apiKeysService } from "@/lib/services/api-keys";
import { findOrCreateUserByWalletAddress } from "@/lib/services/wallet-signup";
import { getAppHost } from "@/lib/utils/app-url";
import { logger } from "@/lib/utils/logger";
import { validateAndConsumeSIWE } from "@/lib/utils/siwe-helpers";
import type { AppEnv } from "@/types/cloud-worker-env";

interface VerifyBody {
  message: string;
  signature: `0x${string}`;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  const redis = buildRedisClient(c.env);
  if (!redis) {
    return c.json({ error: "Service temporarily unavailable" }, 503);
  }

  const body = (await c.req.json().catch(() => null)) as VerifyBody | null;
  if (!body?.message || !body?.signature) {
    return c.json({ error: "message and signature are required" }, 400);
  }

  let address: string;
  try {
    const result = await validateAndConsumeSIWE(
      redis,
      body.message,
      body.signature,
      getAppHost(c.env),
    );
    address = result.address;
  } catch (err) {
    logger.warn("[SIWE Verify] Validation failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "SIWE verification failed" }, 401);
  }

  const { user, isNewAccount } = await findOrCreateUserByWalletAddress(address);
  if (!user.organization_id) {
    return c.json({ error: "Organization creation failed - please try again" }, 400);
  }

  await apiKeysService.deactivateUserKeysByName(user.id, "SIWE sign-in");

  const { plainKey } = await apiKeysService.create({
    user_id: user.id,
    organization_id: user.organization_id,
    name: "SIWE sign-in",
    is_active: true,
  });

  return c.json({
    apiKey: plainKey,
    address: getAddress(address),
    isNewAccount,
    user: {
      id: user.id,
      wallet_address: user.wallet_address,
      organization_id: user.organization_id,
    },
    organization: user.organization
      ? {
          id: user.organization.id,
          name: user.organization.name,
          slug: user.organization.slug,
        }
      : null,
  });
});

export default app;
