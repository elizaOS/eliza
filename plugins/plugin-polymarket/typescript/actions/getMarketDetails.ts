import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { ClobClient, Market } from "@polymarket/clob-client";
import { getMarketTemplate } from "../templates";
import { initializeClobClient } from "../utils/clobClient";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

interface LLMMarketDetailsResult {
  conditionId?: string;
  error?: string;
}

/**
 * Get Market Details Action for Polymarket.
 * Retrieves detailed information about a specific market by its condition ID.
 */
export const getMarketDetailsAction: Action = {
  name: "POLYMARKET_GET_MARKET_DETAILS",
  similes: ["MARKET_INFO", "MARKET_DATA", "SHOW_MARKET", "VIEW_MARKET"].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    "Retrieves detailed information about a specific Polymarket market by its condition ID.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(`[getMarketDetailsAction] Validate called for message: "${message.content?.text}"`);
    const clobApiUrl = runtime.getSetting("CLOB_API_URL");

    if (!clobApiUrl) {
      logger.warn("[getMarketDetailsAction] CLOB_API_URL is required.");
      return false;
    }
    logger.info("[getMarketDetailsAction] Validation passed");
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info("[getMarketDetailsAction] Handler called!");

    const result = await callLLMWithTimeout<LLMMarketDetailsResult>(
      runtime,
      state,
      getMarketTemplate,
      "getMarketDetailsAction"
    );
    let llmResult: LLMMarketDetailsResult = {};
    if (result && !isLLMError(result)) {
      llmResult = result;
    }
    logger.info(`[getMarketDetailsAction] LLM result: ${JSON.stringify(llmResult)}`);

    if (llmResult.error || !llmResult.conditionId) {
      throw new Error(llmResult.error || "Condition ID not found in LLM result.");
    }

    const conditionId = llmResult.conditionId;

    logger.info(`[getMarketDetailsAction] Fetching details for condition ID: ${conditionId}`);

    const client = (await initializeClobClient(runtime)) as ClobClient;
    const market: Market = await client.getMarket(conditionId);

    let responseText = `📊 **Market Details for ${conditionId}**:\n\n`;

    if (market) {
      responseText += `• **Question**: ${market.question || "N/A"}\n`;
      responseText += `• **Description**: ${market.description || "N/A"}\n`;
      responseText += `• **Condition ID**: \`${market.condition_id}\`\n`;
      responseText += `• **Active**: ${market.active ? "✅ Yes" : "❌ No"}\n`;
      responseText += `• **Closed**: ${market.closed ? "✅ Yes" : "❌ No"}\n`;
      if (market.end_date_iso) {
        responseText += `• **End Date**: ${new Date(market.end_date_iso).toLocaleString()}\n`;
      }
      if (market.tokens && market.tokens.length > 0) {
        responseText += `• **Tokens**:\n`;
        market.tokens.forEach((token) => {
          responseText += `   - Token ID: \`${token.token_id}\` (Outcome: ${token.outcome || "N/A"})\n`;
        });
      }
      if (market.market_slug) {
        responseText += `• **Slug**: ${market.market_slug}\n`;
      }
      if (market.minimum_order_size) {
        responseText += `• **Minimum Order Size**: ${market.minimum_order_size}\n`;
      }
      if (market.minimum_tick_size) {
        responseText += `• **Minimum Tick Size**: ${market.minimum_tick_size}\n`;
      }
    } else {
      responseText += `No market found for the provided condition ID.\n`;
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["GET_MARKET_DETAILS"],
      data: {
        market,
        timestamp: new Date().toISOString(),
      },
    };

    if (callback) await callback(responseContent);
    return responseContent;
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Get details for market condition_id abc123 on Polymarket.",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Fetching details for market abc123 on Polymarket...",
          action: "POLYMARKET_GET_MARKET_DETAILS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Show me info about the Polymarket market 0xdef456." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Looking up market information for 0xdef456 on Polymarket...",
          action: "POLYMARKET_GET_MARKET_DETAILS",
        },
      },
    ],
  ],
};
