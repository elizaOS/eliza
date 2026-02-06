import { type NextRequest, NextResponse } from "next/server";
import { cryptoPaymentsService } from "@/lib/services/crypto-payments";
import { cryptoPaymentsRepository } from "@/db/repositories/crypto-payments";
import { logger } from "@/lib/utils/logger";

/**
 * Cron job to clean up expired pending crypto payments.
 * Should be scheduled to run every 5-10 minutes.
 *
 * Vercel Cron: schedule "0/10 * * * *" at path "/api/cron/cleanup-expired-crypto-payments"
 *
 */
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    logger.error("[Crypto Payments Cleanup] CRON_SECRET not configured");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (authHeader !== `Bearer ${cronSecret}`) {
    logger.warn("[Crypto Payments Cleanup] Unauthorized cron attempt");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    logger.info("[Crypto Payments Cleanup] Starting expired payments cleanup");

    const expiredPayments =
      await cryptoPaymentsService.listExpiredPendingPayments();

    if (expiredPayments.length === 0) {
      logger.info("[Crypto Payments Cleanup] No expired payments found");
      return NextResponse.json({
        success: true,
        processed: 0,
        message: "No expired payments to process",
      });
    }

    let markedExpired = 0;
    let errors = 0;

    for (const payment of expiredPayments) {
      try {
        await cryptoPaymentsRepository.markAsExpired(payment.id);
        markedExpired++;

        logger.info("[Crypto Payments Cleanup] Marked payment as expired", {
          paymentId: payment.id,
          organizationId: payment.organization_id,
          expiresAt: payment.expires_at,
        });
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

    logger.info("[Crypto Payments Cleanup] Cleanup completed", {
      total: expiredPayments.length,
      markedExpired,
      errors,
    });

    return NextResponse.json({
      success: true,
      processed: expiredPayments.length,
      markedExpired,
      errors,
    });
  } catch (error) {
    logger.error("[Crypto Payments Cleanup] Cleanup job failed", { error });
    return NextResponse.json({ error: "Cleanup job failed" }, { status: 500 });
  }
}
