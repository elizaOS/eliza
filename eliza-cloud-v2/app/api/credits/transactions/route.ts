import { type NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { creditsService } from "@/lib/services/credits";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

/**
 * GET /api/credits/transactions
 * Lists credit transactions for the authenticated user's organization.
 * Supports both Privy session and API key authentication.
 *
 * @param req - The Next.js request object with optional query params (hours, limit).
 * @returns JSON response with transactions array and period information.
 */
async function handleGET(req: NextRequest) {
  try {
    const { user } = await requireAuthOrApiKeyWithOrg(req);

    if (!user.organization_id) {
      return NextResponse.json(
        { error: "No organization found" },
        { status: 404 },
      );
    }

    const searchParams = req.nextUrl.searchParams;
    const hoursParam = searchParams.get("hours");
    const limitParam = searchParams.get("limit");

    const limit = limitParam ? parseInt(limitParam, 10) : 100;
    const hours = hoursParam ? parseInt(hoursParam, 10) : null;

    const allTransactions = await creditsService.listTransactionsByOrganization(
      user.organization_id,
      limit,
    );

    let transactions = allTransactions;

    if (hours !== null) {
      const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
      transactions = allTransactions.filter(
        (t) => new Date(t.created_at) >= cutoffTime,
      );
    }

    const periodStart = hours
      ? new Date(Date.now() - hours * 60 * 60 * 1000).toISOString()
      : transactions[transactions.length - 1]?.created_at ||
        new Date().toISOString();

    const periodEnd = new Date().toISOString();

    const formattedTransactions = transactions.map((t) => ({
      id: t.id,
      organization_id: t.organization_id,
      amount: Number(t.amount),
      type: t.type,
      description: t.description,
      metadata: t.metadata,
      stripe_payment_intent_id: t.stripe_payment_intent_id,
      created_at: t.created_at.toISOString(),
    }));

    return NextResponse.json({
      transactions: formattedTransactions,
      total: formattedTransactions.length,
      period: {
        start: periodStart,
        end: periodEnd,
      },
    });
  } catch (error) {
    logger.error("Error fetching transactions:", error);

    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json(
      { error: "Failed to fetch transactions" },
      { status: 500 },
    );
  }
}

export const GET = withRateLimit(handleGET, RateLimitPresets.STANDARD);
