import { NextResponse } from "next/server";
import { logger } from "@/lib/utils/logger";
import { creditsService } from "@/lib/services/credits";

/**
 * GET /api/stripe/credit-packs
 * Lists all active credit packs available for purchase.
 * Public endpoint - no authentication required.
 *
 * @returns Array of active credit packs with pricing and credit amounts.
 */
export async function GET() {
  try {
    const creditPacks = await creditsService.listActiveCreditPacks();
    return NextResponse.json({ creditPacks }, { status: 200 });
  } catch (error) {
    logger.error("Error fetching credit packs:", error);
    return NextResponse.json(
      { error: "Failed to fetch credit packs" },
      { status: 500 },
    );
  }
}
