import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { callLLMWithTimeout, isLLMError } from '../utils/llmHelpers';
import { initializeClobClientWithCreds } from '../utils/clobClient';
import { getTradeHistoryTemplate } from '../templates';
import type { ClobClient } from '@polymarket/clob-client';
import type { GetTradesParams, TradesResponse, TradeEntry } from '../types';

interface LLMTradeHistoryResult {
  market?: string;
  assetId?: string;
  limit?: number;
  error?: string;
}

/**
 * Get Trade History Action for Polymarket.
 * Retrieves the authenticated user's trade history.
 */
export const getTradeHistoryAction: Action = {
  name: 'POLYMARKET_GET_TRADE_HISTORY',
  similes: ['MY_TRADES', 'TRADE_LOG', 'FILLED_ORDERS', 'PAST_TRADES', 'TRADING_HISTORY'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Retrieves the authenticated user trade history from Polymarket, optionally filtered by market or asset.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
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
      logger.warn('[getTradeHistoryAction] CLOB_API_URL is required.');
      return false;
    }
    if (!privateKey) {
      logger.warn(
        '[getTradeHistoryAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.'
      );
      return false;
    }
    if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
      const missing: string[] = [];
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
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getTradeHistoryAction] Handler called!');

    let llmResult: LLMTradeHistoryResult = {};
    try {
      const result = await callLLMWithTimeout<LLMTradeHistoryResult>(
        runtime,
        state,
        getTradeHistoryTemplate,
        'getTradeHistoryAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[getTradeHistoryAction] LLM result: ${JSON.stringify(llmResult)}`);
    } catch (error) {
      logger.warn('[getTradeHistoryAction] LLM extraction failed, using defaults', error);
    }

    const market = llmResult.market;
    const assetId = llmResult.assetId;
    const limit = llmResult.limit || 20;

    const apiParams: GetTradesParams = {};
    if (market) apiParams.market = market;
    if (assetId) apiParams.asset_id = assetId;

    logger.info(
      `[getTradeHistoryAction] Fetching trade history with params: ${JSON.stringify(apiParams)}`
    );

    try {
      const client = await initializeClobClientWithCreds(runtime) as ClobClient;
      const tradesResponse: TradesResponse = await client.getTrades(apiParams);
      const trades: TradeEntry[] = tradesResponse.data || [];

      let responseText = `📜 **Your Trade History on Polymarket:**\n\n`;

      if (trades && trades.length > 0) {
        responseText += `Found ${trades.length} trade(s):\n\n`;
        const displayTrades = trades.slice(0, limit);
        displayTrades.forEach((trade: TradeEntry, index: number) => {
          const sideEmoji = trade.side === 'BUY' ? '🟢' : '🔴';
          responseText += `**${index + 1}. Trade ID: ${trade.id}** ${sideEmoji}\n`;
          responseText += `   • **Side**: ${trade.side}\n`;
          responseText += `   • **Price**: $${parseFloat(trade.price).toFixed(4)}\n`;
          responseText += `   • **Size**: ${trade.size}\n`;
          responseText += `   • **Fee**: $${trade.fee_rate_bps ? (parseFloat(trade.size) * parseFloat(trade.price) * parseFloat(trade.fee_rate_bps) / 10000).toFixed(4) : 'N/A'}\n`;
          responseText += `   • **Status**: ${trade.status || 'MATCHED'}\n`;
          if (trade.match_time) {
            responseText += `   • **Time**: ${new Date(trade.match_time).toLocaleString()}\n`;
          }
          responseText += `\n`;
        });

        if (trades.length > limit) {
          responseText += `\n📄 *Showing ${limit} of ${trades.length} trades.*\n`;
        }
        if (tradesResponse.next_cursor) {
          responseText += `*More trades available. Use cursor: \`${tradesResponse.next_cursor}\`*\n`;
        }
      } else {
        responseText += `You have no trades in your history.\n`;
        if (market) responseText += ` (Filtered by market: ${market})`;
        if (assetId) responseText += ` (Filtered by asset_id: ${assetId})`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_TRADE_HISTORY'],
        data: {
          trades: trades.slice(0, limit),
          totalTrades: trades.length,
          filters: apiParams,
          next_cursor: tradesResponse.next_cursor,
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
        data: {
          error: errorMessage,
          filters: apiParams,
          timestamp: new Date().toISOString(),
        },
      };
      if (callback) await callback(errorContent);
      throw error;
    }
  },

  examples: [
    [
      { name: '{{user1}}', content: { text: 'Show my trade history on Polymarket.' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching your trade history from Polymarket...',
          action: 'POLYMARKET_GET_TRADE_HISTORY',
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'What trades have I made on Polymarket?' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Looking up your past trades on Polymarket...',
          action: 'POLYMARKET_GET_TRADE_HISTORY',
        },
      },
    ],
  ],
};
