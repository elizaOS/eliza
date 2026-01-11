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
import { retrieveAllMarketsTemplate } from "../templates";
import type { Market } from "../types";
import { initializeClobClient } from "../utils/clobClient";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

interface LLMRetrieveAllResult {
  maxPages?: number;
  pageSize?: number;
  error?: string;
}

/**
 * Retrieve All Markets Action for Polymarket.
 * Fetches all available markets by paginating through the API.
 */
export const retrieveAllMarketsAction: Action = {
  name: "POLYMARKET_RETRIEVE_ALL_MARKETS",
  similes: ["FETCH_ALL_MARKETS", "DOWNLOAD_MARKETS", "FULL_MARKET_LIST", "COMPLETE_MARKETS"].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    "Retrieves all available markets from Polymarket by paginating through the entire catalog.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(
      `[retrieveAllMarketsAction] Validate called for message: "${message.content?.text}"`
    );
    const clobApiUrl = runtime.getSetting("CLOB_API_URL");

    if (!clobApiUrl) {
      logger.warn("[retrieveAllMarketsAction] CLOB_API_URL is required.");
      return false;
    }
    logger.info("[retrieveAllMarketsAction] Validation passed");
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    logger.info("[retrieveAllMarketsAction] Handler called!");

    const result = await callLLMWithTimeout<LLMRetrieveAllResult>(
      runtime,
      state,
      retrieveAllMarketsTemplate,
      "retrieveAllMarketsAction"
    );
    let llmResult: LLMRetrieveAllResult = {};
    if (result && !isLLMError(result)) {
      llmResult = result;
    }
    logger.info(`[retrieveAllMarketsAction] LLM result: ${JSON.stringify(llmResult)}`);

    const maxPages = llmResult.maxPages || 10; // Limit to prevent excessive API calls

    logger.info(`[retrieveAllMarketsAction] Fetching all markets (max ${maxPages} pages)`);

    const client = (await initializeClobClient(runtime)) as ClobClient;
    const allMarkets: Market[] = [];
    let nextCursor: string | undefined;
    let pageCount = 0;

    // Paginate through all markets
    do {
      const marketsResponse: PaginationPayload = await client.getMarkets(nextCursor);
      const markets: Market[] = marketsResponse.data || [];
      allMarkets.push(...markets);
      nextCursor = marketsResponse.next_cursor;
      pageCount++;

      logger.info(
        `[retrieveAllMarketsAction] Page ${pageCount}: fetched ${markets.length} markets (total: ${allMarkets.length})`
      );

      // Respect rate limits with a small delay
      if (nextCursor && pageCount < maxPages) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } while (nextCursor && pageCount < maxPages);

    // Categorize markets
    const openMarkets = allMarkets.filter((m: Market) => m.active && !m.closed);
    const closedMarkets = allMarkets.filter((m: Market) => m.closed);
    const inactiveMarkets = allMarkets.filter((m: Market) => !m.active && !m.closed);

    let responseText = `📊 **Complete Polymarket Catalog**\n\n`;

    responseText += `**Summary:**\n`;
    responseText += `• **Total Markets**: ${allMarkets.length}\n`;
    responseText += `• **Open/Active**: ${openMarkets.length}\n`;
    responseText += `• **Closed**: ${closedMarkets.length}\n`;
    responseText += `• **Inactive**: ${inactiveMarkets.length}\n`;
    responseText += `• **Pages Fetched**: ${pageCount}\n\n`;

    if (nextCursor) {
      responseText += `⚠️ *More markets available. Reached page limit (${maxPages}). Use "continue fetching markets" for more.*\n\n`;
    }

    // Show sample of open markets
    responseText += `**Sample Open Markets (${Math.min(5, openMarkets.length)} of ${openMarkets.length}):**\n`;
    openMarkets.slice(0, 5).forEach((market: Market, index: number) => {
      responseText += `${index + 1}. ${market.question || market.condition_id}\n`;
      responseText += `   ID: \`${market.condition_id.substring(0, 12)}...\`\n`;
    });

    if (openMarkets.length > 5) {
      responseText += `\n... and ${openMarkets.length - 5} more open markets.\n`;
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["POLYMARKET_RETRIEVE_ALL_MARKETS"],
    };

    if (callback) await callback(responseContent);
    return {
      success: true,
      text: responseText,
      data: {
        totalMarkets: String(allMarkets.length),
        openMarkets: String(openMarkets.length),
        closedMarkets: String(closedMarkets.length),
        inactiveMarkets: String(inactiveMarkets.length),
        pagesFetched: String(pageCount),
        hasMore: String(!!nextCursor),
        nextCursor: nextCursor ?? "",
        timestamp: new Date().toISOString(),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Get all markets from Polymarket." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Fetching the complete catalog of Polymarket markets...",
          action: "POLYMARKET_RETRIEVE_ALL_MARKETS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "How many markets are there on Polymarket?" },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Retrieving all markets from Polymarket to get a count...",
          action: "POLYMARKET_RETRIEVE_ALL_MARKETS",
        },
      },
    ],
  ],
};
