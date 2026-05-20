/**
 * Sell Prediction Action
 * Sell shares from a prediction market position via core PredictionMarketService
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { JsonValue } from "@feed/api";
import { broadcastToChannel } from "@feed/api";
import {
  PredictionDbAdapter,
  PredictionMarketService,
} from "@feed/core/markets/prediction";
import { and, asUser, db, eq, positions } from "@feed/db";
import {
  FEE_CONFIG,
  FeeService,
  invalidateAfterPredictionTrade,
  WalletService,
} from "@feed/engine";
import { AgentPnLService } from "../../../../services/AgentPnLService";
import { logger } from "../../../../shared/logger";

const agentPnLService = new AgentPnLService();

export const sellPredictionAction: Action = {
  name: "SELL_PREDICTION",
  description:
    "Sell shares from YOUR prediction market position. IMPORTANT: Call CHECK_PNL first to see your holdings - you need the position ID and your actual share count. Do NOT rely on conversation history. Requires positionId and shares.",
  parameters: {
    positionId: {
      type: "string",
      description: "The ID of the position to sell from",
      required: true,
    },
    shares: {
      type: "number",
      description: "Number of shares to sell",
      required: true,
    },
  } as unknown as Action["parameters"],
  examples: [
    [
      {
        name: "user",
        content: { text: "Sell 50 shares from my Tesla position" },
      },
      {
        name: "assistant",
        content: { text: "Selling those shares for you..." },
      },
    ],
    [
      {
        name: "user",
        content: { text: "Close out my position on the Apple prediction" },
      },
      {
        name: "assistant",
        content: { text: "I'll sell your shares from that position." },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => true,

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const agentUserId = runtime.agentId;

    // Get parameters from state
    const actionParams = state?.data?.actionParams as
      | { positionId?: string; shares?: number }
      | undefined;

    const positionId = actionParams?.positionId;
    const sharesToSell = actionParams?.shares;

    if (!positionId || !sharesToSell) {
      return {
        success: false,
        text: "Missing parameters. Call CHECK_PNL first to get positionId and share count.",
        error: "Missing parameters: positionId or shares",
      };
    }

    if (sharesToSell <= 0) {
      return {
        success: false,
        text: "Shares must be greater than 0.",
        error: "Invalid shares",
      };
    }

    try {
      // Get position
      const [position] = await db
        .select()
        .from(positions)
        .where(
          and(
            eq(positions.id, positionId),
            eq(positions.userId, agentUserId),
            eq(positions.status, "active"),
          ),
        )
        .limit(1);

      if (!position) {
        return {
          success: false,
          text: `Position not found. Call CHECK_PNL first to get valid positionId.`,
          error: "Position not found",
        };
      }

      const currentShares = Number(position.shares);
      if (sharesToSell > currentShares) {
        return {
          success: false,
          text: `Only ${currentShares.toFixed(2)} shares available. Call CHECK_PNL to verify.`,
          error: "Insufficient shares",
          values: { currentShares },
        };
      }

      const sell = await asUser({ userId: agentUserId }, async (txDb) => {
        const marketId = position.marketId;
        const service = new PredictionMarketService({
          db: new PredictionDbAdapter(txDb),
          wallet: {
            debit: ({ userId, amount, reason, description, relatedId }) =>
              WalletService.debit(
                userId,
                amount,
                reason,
                description ?? "",
                relatedId,
                txDb,
              ),
            credit: ({ userId, amount, reason, description, relatedId }) =>
              WalletService.credit(
                userId,
                amount,
                reason,
                description ?? "",
                relatedId,
                txDb,
              ),
            recordPnL: async ({ userId, pnl, reason, relatedId }) => {
              await WalletService.recordPnL(userId, pnl, reason, relatedId);
            },
            getBalance: (uid: string) => WalletService.getBalance(uid),
          },
          broadcast: {
            emit: (channel, payload) =>
              broadcastToChannel(channel, payload as Record<string, JsonValue>),
          },
          cache: {
            invalidate: () => invalidateAfterPredictionTrade(marketId),
          },
          fees: {
            tradingFeeRate: FEE_CONFIG.TRADING_FEE_RATE,
            platformShare: FEE_CONFIG.PLATFORM_SHARE,
            referrerShare: FEE_CONFIG.REFERRER_SHARE,
            minFeeAmount: FEE_CONFIG.MIN_FEE_AMOUNT,
          },
          feeProcessor: {
            processTradingFee: ({
              userId,
              amount,
              type,
              relatedId,
              positionId,
            }) =>
              FeeService.processTradingFee(
                userId,
                type as (typeof FEE_CONFIG.FEE_TYPES)[keyof typeof FEE_CONFIG.FEE_TYPES],
                amount,
                positionId,
                relatedId,
                txDb, // Pass the existing transaction to avoid nested transaction deadlocks
              ),
          },
        });

        const result = await service.sell({
          userId: agentUserId,
          marketId,
          positionId,
          shares: sharesToSell,
        });

        return { marketId, result };
      });

      const proceeds = sell.result.netProceeds ?? 0;
      const realizedPnL = sell.result.pnl ?? 0;
      const remainingShares = sell.result.remainingShares ?? 0;

      // Record trade for UI/performance tracking
      await agentPnLService.recordTrade({
        agentId: agentUserId,
        userId: agentUserId,
        marketType: "prediction",
        marketId: sell.marketId,
        action: "close",
        side: position.side ? "yes" : "no",
        amount: proceeds,
        price: sell.result.avgPrice,
        reasoning: (state?.data?.thought as string) || "Chat-initiated sell",
        pnl: realizedPnL,
      });

      logger.info("[SELL_PREDICTION] Trade successful", {
        agentUserId,
        positionId,
        sharesSold: sharesToSell,
        proceeds,
        remainingShares,
      });

      return {
        success: true,
        text: `Sold ${sharesToSell} shares for $${proceeds.toFixed(2)}. Remaining: ${remainingShares.toFixed(2)} shares.`,
        data: {
          positionId,
          marketId: sell.marketId,
          side: position.side ? "YES" : "NO",
          sharesSold: sharesToSell,
          proceeds,
          remainingShares,
        },
        values: {
          positionId,
          sharesSold: sharesToSell,
          proceeds,
          remainingShares,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("[SELL_PREDICTION] Error:", errorMsg);
      return {
        success: false,
        text: `Failed to sell shares: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
