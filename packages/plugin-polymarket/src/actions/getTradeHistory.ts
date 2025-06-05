import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { callLLMWithTimeout } from '../utils/llmHelpers';
import { initializeClobClientWithCreds } from '../utils/clobClient';
import type { ClobClient } from '@polymarket/clob-client';
import { getTradeHistoryTemplate } from '../templates';
import type {
  PolymarketTradeClientParams,
  PolymarketTradeRecord,
  PolymarketPaginatedTradesResponse,
} from '../types';

// Simplified params, assuming the official client might take a flexible object or specific known params.
// The error "no properties in common" suggests our detailed OfficialTradeParams was too different.
interface CompatibleTradeParams {
  user_address?: string;
  market_id?: string;
  token_id?: string;
  from_timestamp?: number;
  to_timestamp?: number;
  limit?: number;
  next_cursor?: string;
  // Other potential fields based on common usage, to be verified against official TradeParams
  [key: string]: any; // Allows other properties if needed, making it more flexible
}

// This type should align with the actual structure of trade objects returned by the official client.
// For now, mirroring our existing TradeEntry, assuming it's close to the official structure.
interface AssumedTradeEntry {
  trade_id: string;
  order_id: string;
  user_id: string;
  market_id: string;
  token_id: string;
  side: string;
  type: string;
  price: string;
  size: string;
  fees_paid: string;
  timestamp: string;
  tx_hash?: string;
}

interface AssumedTradesPaginatedResponse {
  trades: AssumedTradeEntry[];
  next_cursor: string;
  limit?: number;
  count?: number;
}

// Helper function to parse date strings (e.g., "yesterday", "2023-01-01") to timestamps
function parseDateToUnixTimestamp(dateString?: string): number | undefined {
  if (!dateString) return undefined;
  if (/^\d+$/.test(dateString)) {
    return parseInt(dateString, 10);
  }
  const date = new Date(dateString);
  if (!isNaN(date.getTime())) {
    return Math.floor(date.getTime() / 1000);
  }
  if (dateString.toLowerCase() === 'yesterday') {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    return Math.floor(yesterday.getTime() / 1000);
  }
  if (dateString.toLowerCase() === 'today') {
    const today = new Date();
    return Math.floor(today.setHours(0, 0, 0, 0) / 1000); // Start of today
  }
  logger.warn(`[getTradeHistoryAction] Could not parse date string: ${dateString}`);
  return undefined;
}

export const getTradeHistoryAction: Action = {
  name: 'GET_TRADE_HISTORY',
  similes: ['USER_TRADE_HISTORY', 'FETCH_MY_TRADES', 'POLYMARKET_TRADES_LIST', 'SHOW_PAST_TRADES'],
  description:
    'Retrieves trade history for a user, with optional filters for market, token, date range, and pagination.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[getTradeHistoryAction] Validate called for message: "${message.content?.text}"`);
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');
    const privateKey =
      runtime.getSetting('WALLET_PRIVATE_KEY') ||
      runtime.getSetting('PRIVATE_KEY') ||
      runtime.getSetting('POLYMARKET_PRIVATE_KEY');

    if (!clobApiUrl) {
      logger.warn('[getTradeHistoryAction] CLOB_API_URL is required but not provided');
      return false;
    }
    if (!privateKey) {
      logger.warn(
        '[getTradeHistoryAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.'
      );
      return false;
    }
    logger.info('[getTradeHistoryAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getTradeHistoryAction] Handler called!');
    // API key/signer should be handled by initializeClobClient now based on new strategy

    let llmParams: {
      userAddress?: string;
      marketId?: string;
      tokenId?: string;
      fromDate?: string;
      toDate?: string;
      limit?: number;
      nextCursor?: string;
      error?: string;
      info?: string;
    } = {};

    try {
      llmParams = await callLLMWithTimeout<typeof llmParams>(
        runtime,
        state,
        getTradeHistoryTemplate,
        'getTradeHistoryAction'
      );
      logger.info(`[getTradeHistoryAction] LLM parameters: ${JSON.stringify(llmParams)}`);
      if (llmParams.error) {
        logger.warn(`[getTradeHistoryAction] LLM indicated an issue: ${llmParams.error}`);
      }
    } catch (error) {
      logger.error('[getTradeHistoryAction] LLM extraction failed:', error);
      // Don't throw here, proceed with undefined LLM params if necessary, let API handle empty/default
    }

    // API parameters aligned with ClobClient.TradeParams
    const apiParams: PolymarketTradeClientParams = {
      maker_address: llmParams.userAddress,
      market: llmParams.marketId,
      asset_id: llmParams.tokenId,
      after: undefined, // Do not use 'after' if explicitly using getTradesPaginated with its own cursor param
    };

    // Timestamps for potential client-side filtering, API does not accept them directly
    const fromTimestamp = parseDateToUnixTimestamp(llmParams.fromDate);
    const toTimestamp = parseDateToUnixTimestamp(llmParams.toDate);
    const requestedLimit = llmParams.limit; // Store for client-side limiting if needed
    const paginationCursor = llmParams.nextCursor; // For the second argument of getTradesPaginated

    Object.keys(apiParams).forEach((key) => {
      const K = key as keyof PolymarketTradeClientParams;
      if (apiParams[K] === undefined) {
        delete apiParams[K];
      }
    });

    logger.info(
      `[getTradeHistoryAction] Calling ClobClient.getTradesPaginated with params: ${JSON.stringify(apiParams)}`
    );
    let clientSideFilteringMessage = '';
    if (fromTimestamp || toTimestamp) {
      clientSideFilteringMessage +=
        " Date range filtering will be applied after fetching data (API doesn't support direct date filters).";
    }
    if (requestedLimit) {
      clientSideFilteringMessage +=
        " Limit will be applied after fetching data (API doesn't directly support limit in this call).";
    }

    try {
      const client = await initializeClobClientWithCreds(runtime);

      // Call client.getTradesPaginated - expecting PolymarketPaginatedTradesResponse structure
      const response: PolymarketPaginatedTradesResponse = await client.getTradesPaginated(
        apiParams,
        paginationCursor
      );

      let tradesToDisplay: PolymarketTradeRecord[] = response.trades || [];

      // Client-side filtering for date range
      if (fromTimestamp) {
        tradesToDisplay = tradesToDisplay.filter(
          (trade) => new Date(trade.match_time).getTime() / 1000 >= fromTimestamp
        );
      }
      if (toTimestamp) {
        tradesToDisplay = tradesToDisplay.filter(
          (trade) => new Date(trade.match_time).getTime() / 1000 <= toTimestamp
        );
      }

      // Client-side limiting
      if (requestedLimit && tradesToDisplay.length > requestedLimit) {
        tradesToDisplay = tradesToDisplay.slice(0, requestedLimit);
        clientSideFilteringMessage += ' Applied requested limit client-side.';
      }

      let responseText = `📜 **Trade History**${clientSideFilteringMessage ? `\n*(${clientSideFilteringMessage.trim()})*` : ''}\n\n`;

      if (tradesToDisplay.length > 0) {
        responseText += tradesToDisplay
          .map(
            (trade: PolymarketTradeRecord) =>
              `• **Trade ID**: ${trade.id}\n` +
              `  ◦ **Market**: ${trade.market}\n` +
              `  ◦ **Asset**: ${trade.asset_id}\n` +
              `  ◦ **Side**: ${trade.side}, **Trader**: ${trade.trader_side}\n` +
              `  ◦ **Price**: ${trade.price}, **Size**: ${trade.size}\n` +
              `  ◦ **Fee BPS**: ${trade.fee_rate_bps}\n` +
              `  ◦ **Status**: ${trade.status}\n` +
              `  ◦ **Time**: ${new Date(trade.match_time).toLocaleString()}\n` +
              (trade.transaction_hash
                ? `  ◦ **Tx Hash**: ${trade.transaction_hash.substring(0, 10)}...\n`
                : '')
          )
          .join('\n\n');

        if (response.next_cursor && response.next_cursor !== 'LTE=') {
          responseText += `\n\n🗒️ *More trades may be available. Use cursor \`${response.next_cursor}\` (as 'nextCursor') to fetch next page.*`;
        } else {
          responseText += `\n\n🔚 *End of trade history for the given API filters.*`;
        }
      } else {
        responseText += 'No trades found matching your criteria.';
        if (llmParams.info && !llmParams.userAddress && !llmParams.marketId && !llmParams.tokenId) {
          responseText += `\n(${llmParams.info})`;
        }
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['GET_TRADE_HISTORY'],
        data: {
          request_params: apiParams,
          requested_cursor: paginationCursor,
          trades: tradesToDisplay,
          next_cursor_from_api: response.next_cursor,
          count_from_api: response.count,
          limit_from_api: response.limit,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[getTradeHistoryAction] Error fetching trade history:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error fetching trade history**: ${errorMessage}`,
        actions: ['GET_TRADE_HISTORY'],
        data: { error: errorMessage, params: apiParams, timestamp: new Date().toISOString() },
      };
      if (callback) await callback(errorContent);
      throw error;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Show my trade history for market 0xMarket123 from last week, limit 10' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Okay, fetching your trade history for market 0xMarket123 from last week, with a limit of 10 trades.',
          actions: ['GET_TRADE_HISTORY'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Get my trades' } },
      {
        name: '{{user2}}',
        content: {
          text: "Fetching your recent trade history. I'll get the latest trades.",
          actions: ['GET_TRADE_HISTORY'],
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Fetch next page of my trades with cursor XYZ123' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Okay, fetching the next page of your trades using cursor XYZ123.',
          actions: ['GET_TRADE_HISTORY'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'What were my trades on token 0xtokenCool for market 0xmarketRad since yesterday?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me look up those trades for you on token 0xtokenCool in market 0xmarketRad since yesterday.',
          actions: ['GET_TRADE_HISTORY'],
        },
      },
    ],
  ],
};
