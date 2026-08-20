/**
 * GET|POST /api/cron/cleanup-expired-crypto-payments
 * Marks expired pending crypto payments as expired.
 *
 * Both verbs are registered: the Worker's scheduled() dispatcher fans out with
 * POST (see `makeCronHandler`), so a GET-only route 404s every cycle.
 */

import { type Context, Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { cryptoPaymentsService } from "@/lib/services/crypto-payments";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

async function handle(c: Context<AppEnv>) {
  try {
    requireCronSecret(c);

    const expiredPayments =
      await cryptoPaymentsService.listExpiredPendingPayments();
    if (expiredPayments.length === 0) {
      return c.json({
        success: true,
        processed: 0,
        message: "No expired payments to process",
      });
    }

    let markedExpired = 0;
    let errors = 0;
    for (const payment of expiredPayments) {
      try {
        await cryptoPaymentsService.expirePaymentWithCallback(payment);
        markedExpired++;
      } catch (error) {
        errors++;
        logger.error(
          "[Crypto Payments Cleanup] Failed to mark payment as expired",
          {
            paymentId: payment.id,
            error,
          },
        );
      }
    }

    return c.json({
      success: true,
      processed: expiredPayments.length,
      markedExpired,
      errors,
    });
  } catch (error) {
    logger.error("[Crypto Payments Cleanup] Cleanup job failed", { error });
    return failureResponse(c, error);
  }
}

app.get("/", handle);
app.post("/", handle);

export default app;
