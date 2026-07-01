/**
 * Buy Prediction Action
 * Buy shares in a prediction market via core PredictionMarketService
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
import { asUser } from "@feed/db";
import {
  FEE_CONFIG,
  FeeService,
  invalidateAfterPredictionTrade,
  WalletService,
} from "@feed/engine";
import { AgentPnLService } from "../../../../services/AgentPnLService";
import { logger } from "../../../../shared/logger";
import { defineActionParameters } from "../../../shared/action-parameters";

const agentPnLService = new AgentPnLService();

export const buyPredictionAction: Action = {
  name: "BUY_PREDICTION",
  description:
    "Buy YES or NO shares in a prediction market using YOUR funds. IMPORTANT: Call CHECK_PREDICTIONS first to get the market ID, and CHECK_BALANCE to verify you have sufficient funds. Requires marketId, side (YES/NO), and amount in dollars.",
  parameters: defineActionParameters({
    marketId: {
      type: "string",
      description: "The ID of the prediction market",
      required: true,
    },
    side: {
      type: "string",
      enum: ["YES", "NO"],
      description: 'Which side to buy: "YES" or "NO"',
      required: true,
    },
    amount: {
      type: "number",
      description: "Dollar amount to spend on shares",
      required: true,
    },
  }),
  examples: [
    [
      {
        name: "user",
        content: { text: "Buy $50 YES on the Tesla prediction" },
      },
      {
        name: "assistant",
        content: { text: "Buying YES shares on that market..." },
      },
    ],
    [
      {
        name: "user",
        content: { text: "Put $100 on NO for the Apple question" },
      },
      {
        name: "assistant",
        content: { text: "I'll buy NO shares for you." },
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
      | { marketId?: string; side?: "YES" | "NO"; amount?: number }
      | undefined;

    const marketId = actionParams?.marketId;
    const side = actionParams?.side?.toUpperCase() as "YES" | "NO" | undefined;
    const amount = actionParams?.amount;

    if (!marketId || !side || !amount) {
      return {
        success: false,
        text: "Missing parameters. Call CHECK_PREDICTIONS first to get marketId.",
        error: "Missing parameters: marketId, side, or amount",
      };
    }

    if (side !== "YES" && side !== "NO") {
      return {
        success: false,
        text: "Invalid side. Must be YES or NO.",
        error: "Invalid side",
      };
    }

    if (amount <= 0) {
      return {
        success: false,
        text: "Amount must be greater than 0.",
        error: "Invalid amount",
      };
    }

    try {
      // Check balance
      const balance = await WalletService.getBalance(agentUserId);
      if (balance.balance < amount) {
        return {
          success: false,
          text: `Insufficient balance ($${balance.balance.toFixed(2)}). Call CHECK_BALANCE first.`,
          error: "Insufficient balance",
          values: { balance: balance.balance },
        };
      }

      const isBuyYes = side === "YES";
      const sideLabel = isBuyYes ? "yes" : "no";

      const result = await asUser({ userId: agentUserId }, async (txDb) => {
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
          cache: { invalidate: () => invalidateAfterPredictionTrade(marketId) },
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

        const market = await service.ensureMarketExists({ marketId });
        const buy = await service.buy({
          userId: agentUserId,
          marketId,
          side: sideLabel,
          amount,
        });

        return { market, buy };
      });

      // Record trade for UI/performance tracking
      await agentPnLService.recordTrade({
        agentId: agentUserId,
        userId: agentUserId,
        marketType: "prediction",
        marketId,
        action: "open",
        side: side.toLowerCase() as "yes" | "no",
        amount,
        price: result.buy.avgPrice,
        reasoning: (state?.data?.thought as string) || "Chat-initiated trade",
      });

      logger.info("[BUY_PREDICTION] Trade successful", {
        agentUserId,
        marketId,
        side,
        shares: result.buy.shares,
        avgPrice: result.buy.avgPrice,
        cost: amount,
      });

      return {
        success: true,
        text: `Bought ${result.buy.shares.toFixed(2)} ${side} shares at $${result.buy.avgPrice.toFixed(4)}.`,
        data: {
          marketId,
          marketQuestion: result.market.question,
          side,
          shares: result.buy.shares,
          avgPrice: result.buy.avgPrice,
          cost: amount,
        },
        values: {
          marketId,
          side,
          shares: result.buy.shares,
          avgPrice: result.buy.avgPrice,
          cost: amount,
        },
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("[BUY_PREDICTION] Error:", errorMsg);
      return {
        success: false,
        text: `Failed to buy shares: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
