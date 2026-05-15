/**
 * GET /api/cron/cleanup-expired-crypto-payments
 * Marks expired pending crypto payments as expired.
 */

import { Hono } from "hono";
import { cryptoPaymentsRepository } from "@/db/repositories/crypto-payments";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { appChargeCallbacksService } from "@/lib/services/app-charge-callbacks";
import { cryptoPaymentsService } from "@/lib/services/crypto-payments";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

function appChargeFailureCallback(payment: {
  id: string;
  expected_amount: string;
  organization_id: string;
  user_id: string | null;
  network: string;
  token: string;
  metadata: unknown;
}) {
  const metadata =
    typeof payment.metadata === "object" &&
    payment.metadata !== null &&
    !Array.isArray(payment.metadata)
      ? (payment.metadata as Record<string, unknown>)
      : {};
  const kind = metadata.kind ?? metadata.type;
  const appId = typeof metadata.app_id === "string" ? metadata.app_id : undefined;
  const chargeRequestId =
    typeof metadata.charge_request_id === "string" ? metadata.charge_request_id : undefined;

  if (kind !== "app_credit_purchase" || !appId || !chargeRequestId) {
    return null;
  }

  return {
    appId,
    chargeRequestId,
    status: "failed" as const,
    provider: "oxapay" as const,
    providerPaymentId: payment.id,
    amountUsd: payment.expected_amount,
    payerUserId: payment.user_id,
    payerOrganizationId: payment.organization_id,
    reason: "expired",
    metadata: {
      crypto_payment_id: payment.id,
      network: payment.network,
      token: payment.token,
    },
  };
}

app.get("/", async (c) => {
  try {
    requireCronSecret(c);

    const expiredPayments = await cryptoPaymentsService.listExpiredPendingPayments();
    if (expiredPayments.length === 0) {
      return c.json({ success: true, processed: 0, message: "No expired payments to process" });
    }

    let markedExpired = 0;
    let errors = 0;
    for (const payment of expiredPayments) {
      try {
        await cryptoPaymentsRepository.markAsExpired(payment.id);
        const callback = appChargeFailureCallback(payment);
        if (callback) {
          await appChargeCallbacksService.dispatch(callback);
        }
        markedExpired++;
      } catch (error) {
        errors++;
        logger.error("[Crypto Payments Cleanup] Failed to mark payment as expired", {
          paymentId: payment.id,
          error,
        });
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
});

export default app;
