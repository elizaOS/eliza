/**
 * POST /api/users/me/wallet/attach
 *
 * Attaches an EVM wallet to the currently-authenticated user by validating a
 * SIWE message + signature against the same nonce store used by /api/auth/siwe.
 *
 * WHY: OAuth signups (Google / Discord / GitHub / Magic Link / Passkey) never
 * receive a `wallet_address`, and the direct-crypto-payments endpoint requires
 * one. Without this route there is no way for an OAuth user to use the BSC
 * promo (or any other wallet-native crypto payment surface).
 *
 * Conflict policy: if the address is already bound to a different user, we
 * return 409 (`wallet_taken`). The pre-existing wallet-keyed account wins;
 * the OAuth user must use that account instead. This matches the unique
 * index on `users.wallet_address` and avoids any account-merge logic.
 */

import { Hono } from "hono";
import { getAddress } from "viem";
import { requireUser } from "@/lib/auth/workers-hono-auth";
import { buildRedisClient } from "@/lib/cache/redis-factory";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import { usersService } from "@/lib/services/users";
import { getAppHost } from "@/lib/utils/app-url";
import { logger } from "@/lib/utils/logger";
import { validateAndConsumeSIWE } from "@/lib/utils/siwe-helpers";
import type { AppEnv } from "@/types/cloud-worker-env";

interface AttachBody {
  message: string;
  signature: `0x${string}`;
}

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STRICT));

app.post("/", async (c) => {
  const user = await requireUser(c);

  if (user.wallet_address) {
    return c.json(
      {
        error: "A wallet is already attached to this account.",
        code: "already_attached",
        wallet_address: user.wallet_address,
      },
      409,
    );
  }

  const redis = buildRedisClient(c.env);
  if (!redis) {
    return c.json({ error: "Service temporarily unavailable" }, 503);
  }

  const body = (await c.req.json().catch(() => null)) as AttachBody | null;
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
    logger.warn("[Wallet Attach] SIWE validation failed", {
      userId: user.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "Wallet signature verification failed" }, 401);
  }

  const checksummed = getAddress(address);
  const normalized = checksummed.toLowerCase();

  const conflict = await usersService.getByWalletAddress(checksummed);
  if (conflict && conflict.id !== user.id) {
    logger.warn("[Wallet Attach] Wallet bound to another user", {
      userId: user.id,
      walletAddress: normalized,
      existingUserId: conflict.id,
    });
    return c.json(
      {
        error:
          "This wallet is already linked to another Eliza Cloud account. Sign in with the wallet-based account instead.",
        code: "wallet_taken",
      },
      409,
    );
  }

  const updated = await usersService.update(user.id, {
    wallet_address: normalized,
    wallet_chain_type: "evm",
    wallet_verified: true,
  });
  if (!updated) {
    logger.error("[Wallet Attach] Update returned no user", {
      userId: user.id,
    });
    return c.json({ error: "Failed to attach wallet" }, 500);
  }

  logger.info("[Wallet Attach] Wallet attached to user", {
    userId: user.id,
    walletAddress: normalized,
  });

  return c.json({
    address: checksummed,
    user: {
      id: updated.id,
      wallet_address: updated.wallet_address,
      wallet_chain_type: updated.wallet_chain_type,
      wallet_verified: updated.wallet_verified,
    },
  });
});

export default app;
