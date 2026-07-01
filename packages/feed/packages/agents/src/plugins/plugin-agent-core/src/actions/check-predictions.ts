/**
 * CHECK_PREDICTIONS Action
 *
 * Returns prediction market data:
 * - Question text
 * - Status (active/resolved)
 * - YES/NO probabilities
 * - Days until resolution
 * - Resolution outcome (if resolved)
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { PredictionPricing } from "@feed/core/markets/prediction/client";
import { db, desc, eq, gte, markets } from "@feed/db";
import type { MessageTag } from "@feed/shared";
import { logger } from "../../../../shared/logger";
import { defineActionParameters } from "../../../shared/action-parameters";

/** Extended ActionResult with optional tag for UI */
interface ActionResultWithTag extends ActionResult {
  tag?: MessageTag;
}

type StatusFilter = "active" | "resolved" | "all";

function getDaysUntil(date: Date | null): number | null {
  if (!date) return null;
  const now = Date.now();
  const diff = date.getTime() - now;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

export const checkPredictionsAction: Action = {
  name: "CHECK_PREDICTIONS",
  description:
    "Check prediction markets - questions, YES/NO odds, resolution dates. Use marketId param for specific market details.",
  parameters: defineActionParameters({
    marketId: {
      type: "string",
      description:
        "Optional market ID to get specific prediction details. If omitted, returns a list of predictions.",
      required: false,
    },
    status: {
      type: "string",
      description:
        'Filter by status: "active", "resolved", or "all" (default: "active"). Only used when marketId is not provided.',
      required: false,
    },
    limit: {
      type: "number",
      description:
        "Number of predictions to show (default: 10, max: 20). Only used when marketId is not provided.",
      required: false,
    },
  }),
  examples: [
    [
      {
        name: "user",
        content: { text: "What predictions are active?" },
      },
      {
        name: "assistant",
        content: { text: "I'll check the active prediction markets." },
      },
    ],
    [
      {
        name: "user",
        content: { text: "Show me market #123" },
      },
      {
        name: "assistant",
        content: { text: "I'll get the details for that prediction market." },
      },
    ],
    [
      {
        name: "user",
        content: { text: "What can I bet on?" },
      },
      {
        name: "assistant",
        content: { text: "I'll show you the available prediction markets." },
      },
    ],
  ],

  validate: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
  ): Promise<boolean> => {
    return true;
  },

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const actionParams = state?.data?.actionParams as
      | { marketId?: string; status?: string; limit?: number }
      | undefined;
    const marketId = actionParams?.marketId;
    const statusFilter = (actionParams?.status as StatusFilter) ?? "active";
    const limit = Math.min(Math.max(actionParams?.limit ?? 10, 1), 20);

    try {
      // =========================================================================
      // SINGLE MARKET MODE: When marketId is provided
      // =========================================================================
      if (marketId) {
        const [prediction] = await db
          .select()
          .from(markets)
          .where(eq(markets.id, marketId))
          .limit(1);

        if (!prediction) {
          return {
            success: false,
            text: `Prediction market #${marketId} not found.`,
            error: "Market not found",
          };
        }

        const yesShares = Number(prediction.yesShares || 0);
        const noShares = Number(prediction.noShares || 0);
        // Use AMM pricing formula: YES price = noShares / total (inverted from share ratio)
        const yesPrice = PredictionPricing.getCurrentPrice(
          yesShares,
          noShares,
          "yes",
        );
        const noPrice = PredictionPricing.getCurrentPrice(
          yesShares,
          noShares,
          "no",
        );
        const yesPercent = Math.round(yesPrice * 100);
        const noPercent = Math.round(noPrice * 100);
        const daysUntil = getDaysUntil(prediction.endDate);

        // Convert boolean resolution to string for UI display
        const resolutionStr =
          prediction.resolution === true
            ? "YES"
            : prediction.resolution === false
              ? "NO"
              : undefined;

        const predictionData = {
          id: prediction.id,
          question: prediction.question,
          yesPercent,
          noPercent,
          resolved: prediction.resolved,
          resolution: resolutionStr,
          daysUntil,
          endDate:
            prediction.endDate?.toISOString().split("T")[0] ?? "unscheduled",
          yesShares,
          noShares,
        };

        logger.info(
          `[CHECK_PREDICTIONS] Retrieved single market: #${marketId}`,
          { marketId, question: prediction.question.substring(0, 40) },
          "CheckPredictions",
        );

        return {
          success: true,
          text: `"${prediction.question}" - ${yesPercent}% YES / ${noPercent}% NO${prediction.resolved ? ` (Resolved: ${resolutionStr})` : ""}`,
          data: { prediction: predictionData },
          values: {
            id: prediction.id,
            question: prediction.question,
            yesPercent,
            noPercent,
            resolved: prediction.resolved,
            daysUntil,
          },
          // Tag for specific market - opens detailed view
          tag: {
            type: "predictions",
            label: "Prediction",
            icon: "Target",
            entityId: String(prediction.id),
            data: { prediction: predictionData },
          },
        } as ActionResultWithTag;
      }

      // =========================================================================
      // LIST MODE: When no marketId provided
      // =========================================================================

      // Build query based on status filter
      let query = db.select().from(markets);

      if (statusFilter === "active") {
        query = query.where(eq(markets.resolved, false)) as typeof query;
        // Also filter for markets that haven't ended
        const now = new Date();
        query = query.where(gte(markets.endDate, now)) as typeof query;
      } else if (statusFilter === "resolved") {
        query = query.where(eq(markets.resolved, true)) as typeof query;
      }
      // 'all' - no filter

      const predictions = await query
        .orderBy(desc(markets.createdAt))
        .limit(limit);

      if (predictions.length === 0) {
        const statusText = statusFilter === "all" ? "" : ` ${statusFilter}`;
        return {
          success: true,
          text: `No${statusText} predictions found.`,
          data: { predictions: [], count: 0, status: statusFilter },
          values: { count: 0 },
        };
      }

      // Format predictions
      const formattedPredictions = predictions.map((p, i) => {
        const yesShares = Number(p.yesShares || 0);
        const noShares = Number(p.noShares || 0);
        // Use AMM pricing formula: YES price = noShares / total (inverted from share ratio)
        const yesPrice = PredictionPricing.getCurrentPrice(
          yesShares,
          noShares,
          "yes",
        );
        const noPrice = PredictionPricing.getCurrentPrice(
          yesShares,
          noShares,
          "no",
        );
        const yesPercent = Math.round(yesPrice * 100);
        const noPercent = Math.round(noPrice * 100);
        const daysUntil = getDaysUntil(p.endDate);

        // Convert boolean resolution to string for UI display
        const resolutionStr =
          p.resolution === true
            ? "YES"
            : p.resolution === false
              ? "NO"
              : undefined;

        return {
          index: i + 1,
          id: p.id,
          question: p.question,
          yesPercent,
          noPercent,
          resolved: p.resolved,
          resolution: resolutionStr,
          daysUntil,
          endDate: p.endDate?.toISOString().split("T")[0] ?? "unscheduled",
        };
      });

      logger.info(
        `[CHECK_PREDICTIONS] Retrieved ${predictions.length} ${statusFilter} predictions`,
        undefined,
        "CheckPredictions",
      );

      return {
        success: true,
        text: `Retrieved ${formattedPredictions.length} ${statusFilter} predictions.`,
        data: {
          predictions: formattedPredictions,
          count: formattedPredictions.length,
          status: statusFilter,
        },
        values: {
          count: formattedPredictions.length,
          markets: formattedPredictions.map((p) => ({
            id: p.id,
            question:
              p.question.length > 80
                ? `${p.question.substring(0, 80)}...`
                : p.question,
            yesPercent: p.yesPercent,
            resolved: p.resolved,
            daysUntil: p.daysUntil,
          })),
        },
        // Tag for list view
        tag: {
          type: "predictions",
          label: "Predictions",
          icon: "Target",
          data: {
            predictions: formattedPredictions,
            status: statusFilter,
          },
        },
      } as ActionResultWithTag;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error("[CHECK_PREDICTIONS] Error:", errorMsg);
      return {
        success: false,
        text: `Failed to retrieve predictions: ${errorMsg}`,
        error: errorMsg,
      };
    }
  },
};
