import {
  recordCronExecution,
  relayCronToStaging,
  requireCronAuth,
  successResponse,
  withErrorHandling,
} from "@feed/api";
import { PerpDbAdapter, PerpMarketService } from "@feed/core/markets/perps";
import { FEE_CONFIG, WalletService } from "@feed/engine";
import { logger } from "@feed/shared";
import type { NextRequest } from "next/server";

export const maxDuration = 300;

export const POST = withErrorHandling(async (request: NextRequest) => {
  const startTime = new Date();

  // Use centralized cron auth (fail-closed in production)
  requireCronAuth(request, { jobName: "PerpFunding" });

  // Relay to staging if configured (Vercel cron runs only on production)
  // but still execute locally (fan-out).
  const relay = await relayCronToStaging(request, "perp-funding");
  if (relay.forwarded) {
    logger.info(
      "Perp funding cron relayed to staging (fan-out: also executing locally)",
      { status: relay.status, error: relay.error },
      "Cron:perp-funding",
    );
  }

  const service = new PerpMarketService({
    db: new PerpDbAdapter(),
    wallet: {
      debit: ({ userId, amount, reason, description, relatedId }) =>
        WalletService.debit(
          userId,
          amount,
          reason,
          description ?? "",
          relatedId,
        ),
      credit: ({ userId, amount, reason, description, relatedId }) =>
        WalletService.credit(
          userId,
          amount,
          reason,
          description ?? "",
          relatedId,
        ),
      recordPnL: async ({ userId, pnl, reason, relatedId }) => {
        await WalletService.recordPnL(userId, pnl, reason, relatedId);
      },
      getBalance: (userId: string) => WalletService.getBalance(userId),
    },
    fees: {
      tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
      platformShare: FEE_CONFIG.PLATFORM_SHARE,
      referrerShare: FEE_CONFIG.REFERRER_SHARE,
      minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
    },
  });

  await service.processFundingAndLiquidations();

  logger.info(
    "Perp funding step executed via cron",
    undefined,
    "Cron:perp-funding",
  );

  // Record metrics
  recordCronExecution("perp-funding", startTime, { success: true });

  return successResponse({ success: true });
});
