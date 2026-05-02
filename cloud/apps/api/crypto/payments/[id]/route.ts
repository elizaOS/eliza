/**
 * GET /api/crypto/payments/[id]
 * Get crypto payment status (and verify confirmation on chain).
 */

import { Hono } from "hono";
import { z } from "zod";
import { cryptoPaymentsRepository } from "@/db/repositories/crypto-payments";
import { requireUserOrApiKeyWithOrg } from "@/lib/auth/workers-hono-auth";
import { RateLimitPresets, rateLimit } from "@/lib/middleware/rate-limit-hono-cloudflare";
import { cryptoPaymentsService } from "@/lib/services/crypto-payments";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.use("*", rateLimit(RateLimitPresets.STANDARD));

app.get("/", async (c) => {
  try {
    const user = await requireUserOrApiKeyWithOrg(c);
    const id = c.req.param("id");

    if (!id || !z.string().uuid().safeParse(id).success) {
      return c.json({ error: "Invalid payment ID" }, 400);
    }

    const payment = await cryptoPaymentsRepository.findById(id);
    if (!payment) return c.json({ error: "Payment not found" }, 404);
    if (payment.organization_id !== user.organization_id) {
      return c.json({ error: "Unauthorized" }, 403);
    }

    const { confirmed, payment: status } = await cryptoPaymentsService.checkAndConfirmPayment(id);
    return c.json({ ...status, confirmed });
  } catch (error) {
    logger.error("[Crypto Payments API] Get payment error:", error);
    return c.json({ error: "Failed to get payment status" }, 500);
  }
});

export default app;
