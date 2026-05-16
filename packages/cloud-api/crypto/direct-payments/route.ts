/**
 * /api/crypto/direct-payments
 * Wallet-native credit purchases. The browser sends a normal wallet transfer
 * to a configured hot wallet/token account; confirmation verifies sender,
 * recipient, token, and amount on-chain before issuing org credits.
 */

import { Hono } from "hono";
import { z } from "zod";
import { requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import {
  RateLimitPresets,
  rateLimit,
} from "@/lib/middleware/rate-limit-hono-cloudflare";
import {
  type DirectWalletNetwork,
  directWalletPaymentsService,
} from "@/lib/services/direct-wallet-payments";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const createSchema = z.object({
  amount: z.number().min(1).max(10000),
  network: z.enum(["base", "bsc", "solana"]),
  payerAddress: z.string().min(1),
  promoCode: z.literal("bsc").optional(),
});

const app = new Hono<AppEnv>();

app.get("/config", rateLimit(RateLimitPresets.STANDARD), (c) => {
  return c.json(directWalletPaymentsService.getConfig(c.env));
});

app.post("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserWithOrg(c);
    if (!user.wallet_address) {
      return c.json(
        {
          error:
            "Connect and verify a wallet on your account before paying with crypto.",
          code: "wallet_required",
        },
        400,
      );
    }

    const body = await c.req.json();
    const validation = createSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        {
          error: "Validation failed",
          details: validation.error.flatten().fieldErrors,
        },
        400,
      );
    }

    const result = await directWalletPaymentsService.createPayment(c.env, {
      organizationId: user.organization_id,
      userId: user.id,
      accountWalletAddress: user.wallet_address,
      payerAddress: validation.data.payerAddress,
      amountUsd: validation.data.amount,
      network: validation.data.network as DirectWalletNetwork,
      promoCode: validation.data.promoCode,
    });

    return c.json({
      paymentId: result.payment.id,
      status: result.payment.status,
      instructions: result.paymentInstructions,
    });
  } catch (error) {
    logger.error("[Direct Crypto Payments API] Create payment error:", error);
    const message =
      error instanceof Error ? error.message : "Failed to create payment";
    return c.json({ error: message }, 400);
  }
});

export default app;
