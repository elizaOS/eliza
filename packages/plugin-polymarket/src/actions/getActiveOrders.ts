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
import { getActiveOrdersTemplate } from '../templates';
import type { OpenOrder, GetOpenOrdersParams as LocalGetOpenOrdersParams } from '../types';

/**
 * Get active orders for a specific market and optionally asset ID.
 */
export const getActiveOrdersAction: Action = {
  name: 'POLYMARKET_GET_ACTIVE_ORDERS',
  similes: [
    'ACTIVE_ORDERS_FOR_MARKET',
    'OPEN_ORDERS_MARKET',
    'LIST_MARKET_ORDERS',
    'SHOW_OPEN_BIDS_ASKS',
  ],
  description:
    'Retrieves active (open) orders for a specified market and, optionally, a specific asset ID (token).',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[getActiveOrdersAction] Validate called for message: "${message.content?.text}"`);
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
      logger.warn('[getActiveOrdersAction] CLOB_API_URL is required');
      return false;
    }
    if (!privateKey) {
      logger.warn(
        '[getActiveOrdersAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.'
      );
      return false;
    }
    if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
      const missing = [];
      if (!clobApiKey) missing.push('CLOB_API_KEY');
      if (!clobApiSecret) missing.push('CLOB_API_SECRET or CLOB_SECRET');
      if (!clobApiPassphrase) missing.push('CLOB_API_PASSPHRASE or CLOB_PASS_PHRASE');
      logger.warn(
        `[getActiveOrdersAction] Missing required API credentials for L2 authentication: ${missing.join(', ')}.`
      );
      return false;
    }
    logger.info('[getActiveOrdersAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getActiveOrdersAction] Handler called!');

    let extractedParams: {
      marketId?: string;
      assetId?: string;
      error?: string;
    } = {};

    try {
      extractedParams = await callLLMWithTimeout<typeof extractedParams>(
        runtime,
        state,
        getActiveOrdersTemplate,
        'getActiveOrdersAction'
      );
      logger.info(`[getActiveOrdersAction] LLM result: ${JSON.stringify(extractedParams)}`);

      if (extractedParams.error || !extractedParams.marketId) {
        throw new Error(extractedParams.error || 'Market ID not found in LLM result.');
      }
    } catch (error) {
      logger.warn('[getActiveOrdersAction] LLM extraction failed, trying regex fallback', error);
      const text = message.content?.text || '';
      const marketRegex = /(?:market|marketId|condition_id)[:\s]?([0-9a-zA-Z_.-]+)/i;
      const assetRegex = /(?:asset|assetId|token_id)[:\s]?([0-9a-zA-Z_.-]+)/i;

      const marketMatch = text.match(marketRegex);
      if (marketMatch && marketMatch[1]) {
        extractedParams.marketId = marketMatch[1];
      }
      const assetMatch = text.match(assetRegex);
      if (assetMatch && assetMatch[1]) {
        extractedParams.assetId = assetMatch[1];
      }

      if (!extractedParams.marketId) {
        const errorMessage = 'Please specify a Market ID to get active orders.';
        logger.error(`[getActiveOrdersAction] Market ID extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ['POLYMARKET_GET_ACTIVE_ORDERS'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
    }

    const apiParams: LocalGetOpenOrdersParams = {
      market: extractedParams.marketId,
      assetId: extractedParams.assetId,
      // nextCursor and address can be added if needed from LLM or settings
    };

    // Remove undefined properties
    Object.keys(apiParams).forEach((key) => {
      const K = key as keyof LocalGetOpenOrdersParams;
      if (apiParams[K] === undefined) delete apiParams[K];
    });

    logger.info(
      `[getActiveOrdersAction] Attempting to fetch open orders for Market ID: ${apiParams.market}, Asset ID: ${apiParams.assetId || 'any'}`
    );

    try {
      const client = (await initializeClobClientWithCreds(runtime)) as ClobClient;

      // The official client's getOpenOrders might return OpenOrdersResponse or OpenOrder[]
      // For now, casting to any and then to OpenOrder[] to match previous logic.
      // The official client's OpenOrderParams type should be used for apiParams if different.
      const openOrdersResponse: any = await client.getOpenOrders(apiParams as any);

      // Determine if the response is an array directly or an object with a data field
      let actualOrders: OpenOrder[];
      let nextCursor: string | undefined;

      if (Array.isArray(openOrdersResponse)) {
        actualOrders = openOrdersResponse;
        // If it's just an array, pagination info might be lost or handled differently by official client
      } else if (openOrdersResponse && Array.isArray(openOrdersResponse.data)) {
        actualOrders = openOrdersResponse.data;
        nextCursor = openOrdersResponse.next_cursor;
      } else {
        // Fallback if structure is unexpected, treat as empty or handle error
        actualOrders = [];
        logger.warn(
          '[getActiveOrdersAction] Unexpected response structure from client.getOpenOrders'
        );
      }

      let responseText = `📊 **Active Orders for Market ${apiParams.market}**`;
      if (apiParams.assetId) {
        responseText += ` (Asset ${apiParams.assetId})`;
      }
      responseText += `\n\n`;

      if (actualOrders.length > 0) {
        responseText += actualOrders
          .map(
            (order) =>
              `• **Order ID**: ${order.order_id}\n` +
              `  ◦ **Side**: ${order.side}\n` +
              `  ◦ **Price**: ${order.price}\n` +
              `  ◦ **Size**: ${order.size}\n` +
              `  ◦ **Filled**: ${order.filled_size}\n` +
              `  ◦ **Status**: ${order.status}\n` +
              `  ◦ **Created**: ${new Date(order.created_at).toLocaleString()}`
          )
          .join('\n\n');
        if (nextCursor && nextCursor !== 'LTE=') {
          responseText += `\n\n🗒️ *More orders available. Use cursor \`${nextCursor}\` to fetch next page.*`;
        }
      } else {
        responseText += `No active orders found for Market ID ${apiParams.market}`;
        if (apiParams.assetId) {
          responseText += ` and Asset ID ${apiParams.assetId}`;
        }
        responseText += `.`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_ACTIVE_ORDERS'],
        data: {
          ...apiParams,
          orders: actualOrders,
          nextCursor,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[getActiveOrdersAction] Error fetching active orders:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error fetching active orders for market ${apiParams.market}**: ${errorMessage}`,
        actions: ['POLYMARKET_GET_ACTIVE_ORDERS'],
        data: { error: errorMessage, ...apiParams, timestamp: new Date().toISOString() },
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
          text: 'Show me the active orders for market 0x123abc and asset 0xTokenYes via Polymarket.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Okay, fetching active orders for market 0x123abc, asset 0xTokenYes via Polymarket.',
          action: 'POLYMARKET_GET_ACTIVE_ORDERS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'What are the open orders on market condition_id_polymarket via Polymarket?',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get the open orders for market condition_id_polymarket via Polymarket.",
          action: 'POLYMARKET_GET_ACTIVE_ORDERS',
        },
      },
    ],
  ],
};
