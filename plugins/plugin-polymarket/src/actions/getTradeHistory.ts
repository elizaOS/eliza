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
import type { GetTradesParams, TradeEntry, TradesResponse } from '../types';

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
function parseDateToTimestamp(dateString?: string): number | undefined {
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
  name: 'POLYMARKET_GET_TRADE_HISTORY',
  similes: ['USER_TRADE_HISTORY', 'FETCH_MY_TRADES', 'TRADES_LIST', 'SHOW_PAST_TRADES'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Retrieves trade history for a user, with optional filters for market, token, date range, and pagination.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[getTradeHistoryAction] Validate called for message: "${message.content?.text}"`);
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');
    const clobApiKey = runtime.getSetting('CLOB_API_KEY');
    const clobApiSecret =
      runtime.getSetting('CLOB_API_SECRET') || runtime.getSetting('CLOB_SECRET');
    const clobApiPassphrase =
      runtime.getSetting('CLOB_API_PASSPHRASE') || runtime.getSetting('CLOB_PASS_PHRASE');
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
    if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
      const missing = [];
      if (!clobApiKey) missing.push('CLOB_API_KEY');
      if (!clobApiSecret) missing.push('CLOB_API_SECRET or CLOB_SECRET');
      if (!clobApiPassphrase) missing.push('CLOB_API_PASSPHRASE or CLOB_PASS_PHRASE');
      logger.warn(
        `[getTradeHistoryAction] Missing required API credentials for L2 authentication: ${missing.join(', ')}.`
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
    }

    const apiParams: CompatibleTradeParams = {
      user_address: llmParams.userAddress,
      market_id: llmParams.marketId,
      token_id: llmParams.tokenId,
      from_timestamp: parseDateToTimestamp(llmParams.fromDate),
      to_timestamp: parseDateToTimestamp(llmParams.toDate),
      limit: llmParams.limit,
      next_cursor: llmParams.nextCursor,
    };

    Object.keys(apiParams).forEach((key) => {
      const K = key as keyof CompatibleTradeParams;
      if (apiParams[K] === undefined) {
        delete apiParams[K];
      }
    });

    logger.info(
      `[getTradeHistoryAction] Calling ClobClient.getTradesPaginated with params: ${JSON.stringify(apiParams)}`
    );

    try {
      // Use initializeClobClientWithCreds
      const client = (await initializeClobClientWithCreds(runtime)) as ClobClient;

      // Using 'any' for response type from official client to bypass strict compile-time checking for now,
      // will rely on runtime structure matching AssumedTradesPaginatedResponse.
      const tradesResponseAny: any = await client.getTradesPaginated(apiParams as any);
      const tradesResponse = tradesResponseAny as AssumedTradesPaginatedResponse;

      let responseText = `📜 **Trade History**\n\n`;
      if (tradesResponse.trades && tradesResponse.trades.length > 0) {
        responseText += tradesResponse.trades
          .map(
            (trade: AssumedTradeEntry) =>
              `• **Trade ID**: ${trade.trade_id}\n` +
              `  ◦ **Market**: ${trade.market_id}\n` +
              `  ◦ **Token**: ${trade.token_id}\n` +
              `  ◦ **Side**: ${trade.side}, **Type**: ${trade.type}\n` +
              `  ◦ **Price**: ${trade.price}, **Size**: ${trade.size}\n` +
              `  ◦ **Fees Paid**: ${trade.fees_paid}\n` +
              `  ◦ **Timestamp**: ${new Date(trade.timestamp).toLocaleString()}\n` +
              (trade.tx_hash ? `  ◦ **Tx Hash**: ${trade.tx_hash.substring(0, 10)}...\n` : '')
          )
          .join('\n\n');

        if (tradesResponse.next_cursor && tradesResponse.next_cursor !== 'LTE=') {
          responseText +=
            `\n\n🗒️ *More trades available. Use cursor \`${tradesResponse.next_cursor}\` to fetch next page.*\n` +
            `You can say: "get next page of trades with cursor ${tradesResponse.next_cursor}"`;
        } else {
          responseText += `\n\n🔚 *End of trade history for the given filters.*`;
        }
      } else {
        responseText += 'No trades found matching your criteria.';
        if (llmParams.info && !llmParams.userAddress && !llmParams.marketId && !llmParams.tokenId) {
          responseText += `\n(${llmParams.info})`;
        }
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_TRADE_HISTORY'],
        data: {
          ...apiParams,
          trades: tradesResponse.trades,
          nextCursor: tradesResponse.next_cursor,
          count: tradesResponse.count,
          limit: tradesResponse.limit,
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
        actions: ['POLYMARKET_GET_TRADE_HISTORY'],
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
        content: {
          text: 'Show my trade history for market 0xMarket123 from last week, limit 10 via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Okay, fetching your trade history for market 0xMarket123 from last week, with a limit of 10 trades via Polymarket.',
          action: 'POLYMARKET_GET_TRADE_HISTORY',
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Get my trades via Polymarket' } },
      {
        name: '{{user2}}',
        content: {
          text: "Fetching your recent trade history via Polymarket. I'll get the latest trades.",
          action: 'POLYMARKET_GET_TRADE_HISTORY',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Fetch next page of my trades with cursor XYZ123 via Polymarket' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Okay, fetching the next page of your trades using cursor XYZ123 via Polymarket.',
          action: 'POLYMARKET_GET_TRADE_HISTORY',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'What were my trades on token 0xtokenCool for market 0xmarketRad since yesterday via Polymarket?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me look up those trades for you on token 0xtokenCool in market 0xmarketRad since yesterday via Polymarket.',
          action: 'POLYMARKET_GET_TRADE_HISTORY',
        },
      },
    ],
  ],
};
