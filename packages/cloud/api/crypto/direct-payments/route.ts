/**
 * /api/crypto/direct-payments
 * Wallet-native credit purchases. The browser sends a normal wallet transfer
 * to a configured hot wallet/token account; confirmation verifies sender,
 * recipient, token, and amount on-chain before issuing org credits.
 */

import { requireUserOrApiKeyWithOrg } from "@elizaos/cloud-shared/auth";
import { ORGANIZATION_CREDIT_CHECKOUT_LIMITS } from "@elizaos/cloud-shared/billing";
import {
  moneyRateLimit,
  RateLimitPresets,
  rateLimit,
} from "@elizaos/cloud-shared/lib/middleware/rate-limit-hono-cloudflare";
import {
  type DirectWalletNetwork,
  directWalletPaymentsService,
} from "@elizaos/cloud-shared/lib/services/direct-wallet-payments";
import { decodeRequestJson } from "@elizaos/cloud-shared/lib/utils/json-parsing";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { z } from "zod";

const createSchema = z.object({
  amount: z
    .number()
    .min(ORGANIZATION_CREDIT_CHECKOUT_LIMITS.minAmountUsd)
    .max(ORGANIZATION_CREDIT_CHECKOUT_LIMITS.maxAmountUsd),
  network: z.enum(["base", "bsc", "solana"]),
  payerAddress: z.string().min(1),
  // BSC supports multiple tokens (BNB native, USDT, U). Other networks ignore
  // this field. Restricted to known symbols so the service does not see an
  // unbounded string.
  tokenSymbol: z.enum(["BNB", "USDT", "U"]).optional(),
  promoCode: z.literal("bsc").optional(),
});

const app = new Hono<AppEnv>();

app.get("/config", rateLimit(RateLimitPresets.STANDARD), (c) => {
  return c.json(directWalletPaymentsService.getConfig(c.env));
});

app.post("/", moneyRateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    // Wallet is NOT required on the account — OAuth-only users (Google /
    // Discord / GitHub / Magic / Passkey) can still pay from any EVM wallet.
    // Credits land on `organization_id` from the authenticated session; the
    // actual paying wallet is recorded from the verified transaction.

    const decodedBody = await decodeRequestJson(c.req);
    if (!decodedBody.ok) {
      // error-policy:J3 malformed JSON is invalid request input.
      return c.json({ success: false, error: "Invalid JSON body" }, 400);
    }
    const validation = createSchema.safeParse(decodedBody.value);
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
      accountWalletAddress: user.wallet_address ?? null,
      payerAddress: validation.data.payerAddress,
      amountUsd: validation.data.amount,
      network: validation.data.network as DirectWalletNetwork,
      tokenSymbol: validation.data.tokenSymbol,
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
