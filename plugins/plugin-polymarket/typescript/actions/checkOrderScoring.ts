import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ClobClient } from "@polymarket/clob-client";
import { POLYMARKET_SERVICE_NAME } from "../constants";
import type { PolymarketService } from "../services/polymarket";
import { checkOrderScoringTemplate } from "../templates";
import type { AreOrdersScoringResponse, OrderScoringActivityData } from "../types";
import { initializeClobClientWithCreds } from "../utils/clobClient";
import { callLLMWithTimeout } from "../utils/llmHelpers";

interface OfficialOrdersScoringParams {
  orderIds: string[];
}

interface LLMScoringResult {
  orderIds?: string[];
  error?: string;
}

/**
 * Check if an order is scoring (eligible for rewards) action for Polymarket.
 */
export const checkOrderScoringAction: Action = {
  name: "POLYMARKET_CHECK_ORDER_SCORING",
  similes: ["ORDERS_ELIGIBLE_FOR_REWARDS", "SCORING_STATUS", "ARE_MY_ORDERS_SCORING"].map(
    (s) => `POLYMARKET_${s}`,
  ),
  description:
    "Checks whether specific Polymarket order IDs are scoring (eligible for liquidity rewards). Use when user provides order ID(s) and asks about scoring/rewards status. Requires CLOB API credentials. Parameters: orderIds (array of order ID strings, required).",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    runtime.logger.info(
      `[checkOrderScoringAction] Validate called for message: "${message.content?.text}"`,
    );
    const clobApiUrl = runtime.getSetting("CLOB_API_URL");
    const clobApiKey = runtime.getSetting("CLOB_API_KEY");
    const clobApiSecret =
      runtime.getSetting("CLOB_API_SECRET") || runtime.getSetting("CLOB_SECRET");
    const clobApiPassphrase =
      runtime.getSetting("CLOB_API_PASSPHRASE") || runtime.getSetting("CLOB_PASS_PHRASE");
    const privateKey =
      runtime.getSetting("WALLET_PRIVATE_KEY") ||
      runtime.getSetting("PRIVATE_KEY") ||
      runtime.getSetting("POLYMARKET_PRIVATE_KEY");

    if (!clobApiUrl) {
      runtime.logger.warn("[checkOrderScoringAction] CLOB_API_URL is required.");
      return false;
    }
    if (!privateKey) {
      runtime.logger.warn(
        "[checkOrderScoringAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.",
      );
      return false;
    }
    if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
      const missing: string[] = [];
      if (!clobApiKey) missing.push("CLOB_API_KEY");
      if (!clobApiSecret) missing.push("CLOB_API_SECRET or CLOB_SECRET");
      if (!clobApiPassphrase) missing.push("CLOB_API_PASSPHRASE or CLOB_PASS_PHRASE");
      runtime.logger.warn(
        `[checkOrderScoringAction] Missing required API credentials for L2 authentication: ${missing.join(", ")}.`,
      );
      return false;
    }
    runtime.logger.info("[checkOrderScoringAction] Validation passed");
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    runtime.logger.info("[checkOrderScoringAction] Handler called!");

    let llmResult: LLMScoringResult = {};
    try {
      const result = await callLLMWithTimeout<LLMScoringResult>(
        runtime,
        state,
        checkOrderScoringTemplate,
        "checkOrderScoringAction",
      );
      if (result) {
        llmResult = result;
      }
      runtime.logger.info(`[checkOrderScoringAction] LLM result: ${JSON.stringify(llmResult)}`);

      if (llmResult.error || !llmResult.orderIds || llmResult.orderIds.length === 0) {
        throw new Error(llmResult.error || "Order IDs not found in LLM result.");
      }
    } catch (error) {
      runtime.logger.warn(
        "[checkOrderScoringAction] LLM extraction failed, trying regex fallback",
        error,
      );
      const text = message.content?.text || "";
      const orderIdRegex =
        /(?:order|ID|orders|IDs|check\s+scoring\s+for)[:\s#]?([0-9a-zA-Z_,\s\-_]+(?:0x[0-9a-fA-F]+)?)/gi;
      let matches: RegExpExecArray | null = orderIdRegex.exec(text);
      const extractedIds: string[] = [];
      while (matches !== null) {
        matches[1].split(/[\s,]+/).forEach((id) => {
          if (id.trim()) extractedIds.push(id.trim());
        });
        matches = orderIdRegex.exec(text);
      }

      if (extractedIds.length > 0) {
        llmResult.orderIds = extractedIds.filter((id, index, self) => self.indexOf(id) === index);
      } else {
        const errorMessage = "Please specify one or more Order IDs to check scoring status.";
        runtime.logger.error(
          `[checkOrderScoringAction] Order ID extraction failed. Text: "${text}"`,
        );
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ["CHECK_ORDER_SCORING"],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        return { success: false, text: errorMessage, error: errorMessage };
      }
      runtime.logger.info(
        `[checkOrderScoringAction] Regex extracted Order IDs: ${JSON.stringify(llmResult.orderIds)}`,
      );
    }

    const orderIdsToScore = llmResult.orderIds ?? [];
    const apiParams: OfficialOrdersScoringParams = {
      orderIds: orderIdsToScore,
    };

    runtime.logger.info(
      `[checkOrderScoringAction] Checking scoring for Order IDs: ${orderIdsToScore.join(", ")}`,
    );

    try {
      const client = (await initializeClobClientWithCreds(runtime)) as ClobClient;
      const scoringResponse = (await client.areOrdersScoring(
        apiParams,
      )) as AreOrdersScoringResponse;

      let responseText = `📊 **Order Scoring Status**:\n\n`;
      if (Object.keys(scoringResponse).length > 0) {
        for (const [orderId, isScoring] of Object.entries(scoringResponse)) {
          responseText += `  • **Order ${orderId}**: ${isScoring ? "✅ Scoring" : "❌ Not Scoring"}\n`;
        }
      } else {
        responseText += "Could not retrieve scoring status or no valid order IDs provided.";
      }

      const responseContent: Content = {
        text: responseText,
        actions: ["CHECK_ORDER_SCORING"],
      };

      if (callback) await callback(responseContent);

      // Record activity
      const service = runtime.getService(POLYMARKET_SERVICE_NAME) as PolymarketService | undefined;
      if (service && Object.keys(scoringResponse).length > 0) {
        const scoringCount = Object.values(scoringResponse).filter((v) => v === true).length;
        const notScoringCount = Object.values(scoringResponse).filter((v) => v === false).length;

        const activityData: OrderScoringActivityData = {
          type: "order_scoring",
          orderIds: orderIdsToScore,
          results: scoringResponse,
          scoringCount,
          notScoringCount,
        };
        await service.recordActivity(activityData);
      }

      return {
        success: true,
        text: responseText,
        data: {
          orderIds: orderIdsToScore,
          scoringResponse: JSON.stringify(scoringResponse),
          timestamp: new Date().toISOString(),
        },
      };
    } catch (error) {
      runtime.logger.error(
        `[checkOrderScoringAction] Error checking order scoring for IDs ${orderIdsToScore.join(", ")}:`,
        error,
      );
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred.";
      const errorContent: Content = {
        text: `❌ **Error checking order scoring**: ${errorMessage}`,
        actions: ["CHECK_ORDER_SCORING"],
      };
      if (callback) await callback(errorContent);
      return {
        success: false,
        text: `Error checking order scoring: ${errorMessage}`,
        error: errorMessage,
        data: {
          orderIds: orderIdsToScore,
          timestamp: new Date().toISOString(),
        },
      };
    }
  },

  examples: [
    // Example 1: Direct request with order IDs - SHOULD use action
    [
      {
        name: "{{user1}}",
        content: {
          text: "I placed some limit orders earlier. Are orders 0xabc123 and 0xdef456 scoring?",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Let me check the scoring status for those orders.",
          action: "POLYMARKET_CHECK_ORDER_SCORING",
        },
      },
    ],
    // Example 2: Multi-turn - user provides context then asks
    [
      { name: "{{user1}}", content: { text: "I have a limit order on the Trump market" } },
      {
        name: "{{user2}}",
        content: {
          text: "I can help check if it's earning liquidity rewards. What's the order ID?",
        },
      },
      { name: "{{user1}}", content: { text: "The order ID is 0x789abc" } },
      {
        name: "{{user2}}",
        content: {
          text: "Checking scoring status for order 0x789abc.",
          action: "POLYMARKET_CHECK_ORDER_SCORING",
        },
      },
    ],
    // Example 3: User asks vaguely - should NOT use action yet
    [
      { name: "{{user1}}", content: { text: "Am I earning any rewards on Polymarket?" } },
      {
        name: "{{user2}}",
        content: {
          text: "I can check if your specific limit orders are scoring for rewards. Could you provide the order ID(s) you want to check? You can find them in your order history.",
        },
      },
    ],
    // Example 4: User wants order status, not scoring - should NOT use this action
    [
      {
        name: "{{user1}}",
        content: { text: "What's the status of my order 0x123abc? Is it filled?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "You're asking about order status and fills. Let me fetch the order details for you.",
          action: "POLYMARKET_GET_ORDER_DETAILS",
        },
      },
    ],
    // Example 5: Multiple orders after placing trades
    [
      {
        name: "{{user1}}",
        content: {
          text: "I just placed 3 limit orders. Can you check if they're scoring? IDs are order1, order2, order3",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Checking scoring status for all three orders.",
          action: "POLYMARKET_CHECK_ORDER_SCORING",
        },
      },
    ],
  ],
};
