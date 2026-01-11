import {
  type Action,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { ClobClient, PaginationPayload } from "@polymarket/clob-client";
import { getSamplingMarketsTemplate } from "../templates";
import type { Market } from "../types";
import { initializeClobClient } from "../utils/clobClient";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

interface LLMSamplingMarketsResult {
  limit?: number;
  next_cursor?: string;
  error?: string;
}

/**
 * Get Sampling Markets Action for Polymarket.
 * Retrieves a sample of markets from the Polymarket API.
 */
export const getSamplingMarketsAction: Action = {
  name: "POLYMARKET_GET_SAMPLING_MARKETS",
  similes: ["SAMPLE_MARKETS", "RANDOM_MARKETS", "EXPLORE_MARKETS", "DISCOVER_MARKETS"].map(
    (s) => `POLYMARKET_${s}`
  ),
  description: "Retrieves a sample of markets from the Polymarket CLOB API for exploration.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(
      `[getSamplingMarketsAction] Validate called for message: "${message.content?.text}"`
    );
    const clobApiUrl = runtime.getSetting("CLOB_API_URL");

    if (!clobApiUrl) {
      logger.warn("[getSamplingMarketsAction] CLOB_API_URL is required.");
      return false;
    }
    logger.info("[getSamplingMarketsAction] Validation passed");
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    logger.info("[getSamplingMarketsAction] Handler called!");

    const result = await callLLMWithTimeout<LLMSamplingMarketsResult>(
      runtime,
      state,
      getSamplingMarketsTemplate,
      "getSamplingMarketsAction"
    );
    let llmResult: LLMSamplingMarketsResult = {};
    if (result && !isLLMError(result)) {
      llmResult = result;
    }
    logger.info(`[getSamplingMarketsAction] LLM result: ${JSON.stringify(llmResult)}`);

    const limit = llmResult.limit || 5;
    const nextCursor = llmResult.next_cursor;

    logger.info(`[getSamplingMarketsAction] Fetching sampling markets with limit=${limit}`);

    const client = (await initializeClobClient(runtime)) as ClobClient;
    const marketsResponse: PaginationPayload = await client.getMarkets(nextCursor);
    const allMarkets: Market[] = marketsResponse.data || [];

    // Randomly sample markets
    const shuffled = [...allMarkets].sort(() => Math.random() - 0.5);
    const sampledMarkets = shuffled.slice(0, limit);

    let responseText = `🎲 **Sample Polymarket Markets**:\n\n`;

    if (sampledMarkets && sampledMarkets.length > 0) {
      responseText += `Here are ${sampledMarkets.length} randomly sampled market(s):\n\n`;
      sampledMarkets.forEach((market: Market, index: number) => {
        const statusEmoji = market.active && !market.closed ? "🟢" : "🔴";
        responseText += `**${index + 1}. ${market.question || market.condition_id}** ${statusEmoji}\n`;
        responseText += `   • **Condition ID**: \`${market.condition_id}\`\n`;
        responseText += `   • **Active**: ${market.active ? "Yes" : "No"}\n`;
        responseText += `   • **Closed**: ${market.closed ? "Yes" : "No"}\n`;
        if (market.end_date_iso) {
          responseText += `   • **End Date**: ${new Date(market.end_date_iso).toLocaleString()}\n`;
        }
        if (market.tokens && market.tokens.length > 0) {
          responseText += `   • **Outcomes**: ${market.tokens.length}\n`;
        }
        responseText += `\n`;
      });

      responseText += `\n💡 *These are randomly sampled markets. Run again for different results.*\n`;
      if (marketsResponse.next_cursor) {
        responseText += `*More markets available with cursor: \`${marketsResponse.next_cursor}\`*\n`;
      }
    } else {
      responseText += `No markets found to sample.\n`;
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["POLYMARKET_GET_SAMPLING_MARKETS"],
    };

    if (callback) await callback(responseContent);
    return {
      success: true,
      text: responseText,
      data: {
        count: String(sampledMarkets.length),
        limit: String(limit),
        nextCursor: marketsResponse.next_cursor ?? "",
        timestamp: new Date().toISOString(),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Show me some random markets on Polymarket." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Fetching a random sample of markets from Polymarket...",
          action: "POLYMARKET_GET_SAMPLING_MARKETS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "What markets can I explore on Polymarket?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Sampling some markets from Polymarket for you to explore...",
          action: "POLYMARKET_GET_SAMPLING_MARKETS",
        },
      },
    ],
  ],
};
