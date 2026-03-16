import { type NextRequest, NextResponse } from "next/server";
import { requireAuthWithOrg } from "@/lib/auth";
import { cryptoPaymentsService } from "@/lib/services/crypto-payments";
import { cryptoPaymentsRepository } from "@/db/repositories/crypto-payments";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";
import { logger } from "@/lib/utils/logger";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function handleGetPayment(req: NextRequest, context?: RouteContext) {
  try {
    const user = await requireAuthWithOrg();
    if (!context) {
      return NextResponse.json(
        { error: "Missing route params" },
        { status: 400 },
      );
    }
    const { id } = await context.params;

    if (!user.organization_id) {
      return NextResponse.json(
        { error: "Organization not found" },
        { status: 404 },
      );
    }

    const payment = await cryptoPaymentsRepository.findById(id);

    if (!payment) {
      return NextResponse.json({ error: "Payment not found" }, { status: 404 });
    }

    if (payment.organization_id !== user.organization_id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
    }

    const { confirmed, payment: status } =
      await cryptoPaymentsService.checkAndConfirmPayment(id);

    return NextResponse.json({
      ...status,
      confirmed,
    });
  } catch (error) {
    logger.error("[Crypto Payments API] Get payment error:", error);
    return NextResponse.json(
      { error: "Failed to get payment status" },
      { status: 500 },
    );
  }
}

export const GET = withRateLimit(handleGetPayment, RateLimitPresets.STANDARD);
