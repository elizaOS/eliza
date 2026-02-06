/**
 * Redemption Processing Cron Job
 *
 * POST /api/cron/process-redemptions
 *
 * Processes approved token redemptions and executes payouts.
 * Should be called by a cron scheduler (e.g., Vercel Cron, AWS EventBridge).
 *
 * SECURITY:
 * 1. Requires CRON_SECRET header for authentication
 * 2. Processes in batches with distributed locking
 * 3. Handles retries with exponential backoff
 * 4. Logs all operations for audit
 *
 * RECOMMENDED SCHEDULE: Every 5 minutes
 */

import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { payoutProcessorService } from "@/lib/services/payout-processor";
import { logger } from "@/lib/utils/logger";

export const maxDuration = 120; // 2 minutes max for processing

/**
 * Verify cron secret for authentication using timing-safe comparison.
 * SECURITY: Uses timingSafeEqual to prevent timing attacks on secret.
 */
function verifyCronSecret(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    logger.error("[Redemption Cron] CRON_SECRET not configured");
    return false;
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader) {
    return false;
  }

  // Support both "Bearer <secret>" and just "<secret>"
  const providedSecret = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7)
    : authHeader;

  // SECURITY: Timing-safe comparison to prevent timing attacks
  try {
    const secretBuffer = Buffer.from(cronSecret, "utf-8");
    const providedBuffer = Buffer.from(providedSecret, "utf-8");

    // timingSafeEqual requires same length, so pad shorter one
    if (secretBuffer.length !== providedBuffer.length) {
      return false;
    }

    return timingSafeEqual(secretBuffer, providedBuffer);
  } catch {
    return false;
  }
}

/**
 * POST /api/cron/process-redemptions
 * Process approved token redemptions.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // Verify cron secret
  if (!verifyCronSecret(request)) {
    logger.warn("[Redemption Cron] Unauthorized access attempt");
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 },
    );
  }

  logger.info("[Redemption Cron] Starting redemption processing");

  // Check if payout processor is configured (support both naming conventions)
  const evmConfigured = !!(
    process.env.EVM_PAYOUT_PRIVATE_KEY || process.env.EVM_PRIVATE_KEY
  );
  const solanaConfigured = !!process.env.SOLANA_PAYOUT_PRIVATE_KEY;

  if (!evmConfigured && !solanaConfigured) {
    logger.warn("[Redemption Cron] No payout wallets configured");
    return NextResponse.json({
      success: true,
      message: "Payout processing skipped - no wallets configured",
      evmConfigured,
      solanaConfigured,
    });
  }

  // Process batch
  const stats = await payoutProcessorService.processBatch();

  // Check hot wallet balances and include in response
  const balances = await payoutProcessorService.checkHotWalletBalances();

  logger.info("[Redemption Cron] Processing completed", stats);

  return NextResponse.json({
    success: true,
    stats,
    evmConfigured,
    solanaConfigured,
    balances: {
      evm: balances.evm.configured ? balances.evm.balances : "not configured",
      solana: balances.solana.configured
        ? balances.solana.balance
        : "not configured",
    },
  });
}

/**
 * GET - Health check for monitoring
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  // Allow health checks without auth for monitoring (support both naming conventions)
  const evmConfigured = !!(
    process.env.EVM_PAYOUT_PRIVATE_KEY || process.env.EVM_PRIVATE_KEY
  );
  const solanaConfigured = !!process.env.SOLANA_PAYOUT_PRIVATE_KEY;

  return NextResponse.json({
    healthy: true,
    evmConfigured,
    solanaConfigured,
    cronSecretConfigured: !!process.env.CRON_SECRET,
  });
}
