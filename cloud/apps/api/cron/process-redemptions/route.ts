/**
 * /api/cron/process-redemptions
 * Processes approved token redemptions and executes payouts (every 5min).
 * POST is protected by CRON_SECRET; GET is an unauthenticated health check.
 */

import { Hono } from "hono";
import { failureResponse } from "@/lib/api/cloud-worker-errors";
import { requireCronSecret } from "@/lib/auth/workers-hono-auth";
import { payoutProcessorService } from "@/lib/services/payout-processor";
import { logger } from "@/lib/utils/logger";
import type { AppEnv } from "@/types/cloud-worker-env";

const app = new Hono<AppEnv>();

app.post("/", async (c) => {
  try {
    requireCronSecret(c);

    logger.info("[Redemption Cron] Starting redemption processing");

    const evmConfigured = !!(c.env.EVM_PAYOUT_PRIVATE_KEY || c.env.EVM_PRIVATE_KEY);
    const solanaConfigured = !!c.env.SOLANA_PAYOUT_PRIVATE_KEY;

    if (!evmConfigured && !solanaConfigured) {
      logger.warn("[Redemption Cron] No payout wallets configured");
      return c.json({
        success: true,
        message: "Payout processing skipped - no wallets configured",
        evmConfigured,
        solanaConfigured,
      });
    }

    const stats = await payoutProcessorService.processBatch();
    const balances = await payoutProcessorService.checkHotWalletBalances();

    logger.info("[Redemption Cron] Processing completed", stats);

    return c.json({
      success: true,
      stats,
      evmConfigured,
      solanaConfigured,
      balances: {
        evm: balances.evm.configured ? balances.evm.balances : "not configured",
        solana: balances.solana.configured ? balances.solana.balance : "not configured",
      },
    });
  } catch (error) {
    return failureResponse(c, error);
  }
});

app.get("/", (c) => {
  const evmConfigured = !!(c.env.EVM_PAYOUT_PRIVATE_KEY || c.env.EVM_PRIVATE_KEY);
  const solanaConfigured = !!c.env.SOLANA_PAYOUT_PRIVATE_KEY;
  return c.json({
    healthy: true,
    evmConfigured,
    solanaConfigured,
    cronSecretConfigured: !!c.env.CRON_SECRET,
  });
});

export default app;
