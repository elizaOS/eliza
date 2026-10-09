/**
 * GET|POST /api/cron/cleanup-expired-crypto-payments
 * Marks expired pending crypto payments as expired.
 *
 * Both verbs are registered: the Worker's scheduled() dispatcher fans out with
 * POST (see `makeCronHandler`), so a GET-only route 404s every cycle.
 */

import { requireCronSecret } from "@elizaos/cloud-shared/auth";
import { failureResponse } from "@elizaos/cloud-shared/lib/api/cloud-worker-errors";
import { cryptoPaymentsService } from "@elizaos/cloud-shared/lib/services/crypto-payments";
import { logger } from "@elizaos/cloud-shared/lib/utils/logger";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { type Context, Hono } from "hono";

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
        await cryptoPaymentsService.expirePayment(payment);
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
