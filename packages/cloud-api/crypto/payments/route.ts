/**
 * /api/crypto/payments
 * POST: create a new crypto payment (OxaPay) for the authed org. Strict
 * rate limit because it allocates external resources.
 * GET: list all crypto payments for the authed org. Standard rate limit.
 */

import { Hono } from "hono";
import { z } from "zod";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireUserOrApiKeyWithOrg, requireUserWithOrg } from "@/lib/auth/workers-hono-auth";
import { SUPPORTED_PAY_CURRENCIES } from "@/lib/config/crypto";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { CryptoPaymentError, cryptoPaymentsService } from "@/lib/services/crypto-payments";
import { isOxaPayConfigured } from "@/lib/services/oxapay";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const createPaymentSchema = z.object({
  amount: z.number().min(1, "Minimum amount is $1").max(10000, "Maximum amount is $10,000"),
  currency: z.string().default("USD"),
  payCurrency: z.enum(SUPPORTED_PAY_CURRENCIES).default("USDT"),
  network: z.enum(["ERC20", "TRC20", "BEP20", "POLYGON", "SOL", "BASE", "ARB", "OP"]).optional(),
});

const app = new Hono<AppEnv>();

app.post("/", rateLimit(RateLimitPresets.STRICT), async (c) => {
  try {
    const user = await requireUserWithOrg(c);

    if (!isOxaPayConfigured()) {
      return c.json({ error: "Crypto payments not available" }, 503);
    }

    const body = await c.req.json();
    const validation = createPaymentSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: "Validation failed", details: validation.error.flatten().fieldErrors },
        400,
      );
    }

    const { amount, currency, payCurrency, network } = validation.data;

    const result = await cryptoPaymentsService.createPayment({
      organizationId: user.organization_id,
      userId: user.id,
      amount,
      currency,
      payCurrency,
      network,
    });

    return c.json({
      paymentId: result.payment.id,
      trackId: result.trackId,
      payLink: result.payLink,
      expiresAt: result.expiresAt.toISOString(),
      creditsToAdd: result.creditsToAdd,
    });
  } catch (error) {
    logger.error("[Crypto Payments API] Create payment error:", error);
    if (error instanceof CryptoPaymentError) {
      const statusMap: Record<string, { status: 400 | 503 | 500; message: string }> = {
        INVALID_UUID: { status: 400, message: "Invalid request format" },
        AMOUNT_TOO_SMALL: { status: 400, message: "Amount too small" },
        AMOUNT_TOO_LARGE: { status: 400, message: "Amount too large" },
        SERVICE_NOT_CONFIGURED: { status: 503, message: "Service temporarily unavailable" },
      };
      const response = statusMap[error.code] || { status: 500 as const, message: error.message };
      return c.json({ error: response.message }, response.status);
    }
    return failureResponse(c, error);
  }
});

app.get("/", rateLimit(RateLimitPresets.STANDARD), async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const payments = await cryptoPaymentsService.listPaymentsByOrganization(user.organization_id);
    return c.json({ payments });
  } catch (error) {
    logger.error("[Crypto Payments API] List payments error:", error);
    if (error instanceof CryptoPaymentError && error.code === "INVALID_UUID") {
      return c.json({ error: "Invalid request format" }, 400);
    }
    return failureResponse(c, error);
  }
});

export default app;
