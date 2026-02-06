/**
 * Payout System Status API
 *
 * GET /api/v1/redemptions/status
 *
 * Returns the current status of the token redemption/payout system.
 * Useful for:
 * - Showing users which networks are available
 * - Displaying maintenance messages
 * - Checking wallet balances (for admins)
 */

import { NextRequest, NextResponse } from "next/server";
import { payoutStatusService } from "@/lib/services/payout-status";
import { withRateLimit, RateLimitPresets } from "@/lib/middleware/rate-limit";

/**
 * GET /api/v1/redemptions/status
 * Get payout system status
 */
async function getStatusHandler(request: NextRequest): Promise<Response> {
  const status = await payoutStatusService.getStatus();

  // Build user-friendly response
  const availableNetworks = status.networks
    .filter((n) => n.status === "operational" || n.status === "low_balance")
    .map((n) => n.network);

  const unavailableNetworks = status.networks
    .filter((n) => n.status === "no_balance" || n.status === "not_configured")
    .map((n) => n.network);

  // Determine if any payouts are possible
  const canRedeem = availableNetworks.length > 0;

  // User-friendly message
  let message: string;
  if (!canRedeem) {
    message =
      "Token redemption is temporarily unavailable. Our team is working to restore service. Please check back soon.";
  } else if (unavailableNetworks.length > 0) {
    message = `Token redemption is available on: ${availableNetworks.join(", ")}. Some networks (${unavailableNetworks.join(", ")}) are temporarily unavailable.`;
  } else {
    message = "All payout networks are operational.";
  }

  return NextResponse.json({
    success: true,

    // High-level status
    canRedeem,
    message,

    // Available networks for redemption
    availableNetworks,
    unavailableNetworks,

    // Detailed status (useful for debugging/admin)
    networks: status.networks.map((n) => ({
      network: n.network,
      available: n.status === "operational" || n.status === "low_balance",
      status: n.status,
      message: n.message,
      // Only show balance info if available (useful for admins)
      ...(n.hasBalance && { balanceAvailable: n.balance > 0 }),
    })),

    // Warnings for display
    warnings: status.warnings.filter((w) => !w.includes("balance")), // Don't expose balance details

    lastChecked: status.lastChecked.toISOString(),
  });
}

export const GET = withRateLimit(getStatusHandler, RateLimitPresets.STANDARD);

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-API-Key, X-App-Id",
    },
  });
}
