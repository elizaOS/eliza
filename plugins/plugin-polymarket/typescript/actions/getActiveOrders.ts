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
import type { ClobClient } from '@polymarket/clob-client';
import { getActiveOrdersTemplate } from '../templates';
import type { OpenOrder, GetOpenOrdersParams } from '../types';

interface OfficialOpenOrdersParams {
  market?: string;
  asset_id?: string;
}

interface LLMOrdersResult {
  market?: string;
  assetId?: string;
  error?: string;
}

/**
 * Get Active Orders Action for Polymarket.
 * Fetches open orders for the authenticated user, optionally filtered by market or asset.
 */
export const getActiveOrdersAction: Action = {
  name: 'POLYMARKET_GET_ACTIVE_ORDERS',
  similes: [
    'GET_OPEN_ORDERS',
    'VIEW_MY_ORDERS',
    'LIST_PENDING_ORDERS',
    'SHOW_UNFILLED_ORDERS',
    'ORDERS_IN_BOOK',
  ].map((s) => `POLYMARKET_${s}`),
  description:
    'Fetches open/active orders for the authenticated user from Polymarket, optionally filtered by market or asset.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
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
      logger.warn('[getActiveOrdersAction] CLOB_API_URL is required.');
      return false;
    }
    if (!privateKey) {
      logger.warn(
        '[getActiveOrdersAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.'
      );
      return false;
    }
    if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
      const missing: string[] = [];
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
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getActiveOrdersAction] Handler called!');

    let llmResult: LLMOrdersResult = {};
    try {
      const result = await callLLMWithTimeout<LLMOrdersResult>(
        runtime,
        state,
        getActiveOrdersTemplate,
        'getActiveOrdersAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[getActiveOrdersAction] LLM result: ${JSON.stringify(llmResult)}`);
    } catch (error) {
      logger.warn('[getActiveOrdersAction] LLM extraction failed, will attempt to list all active orders', error);
    }

    if (llmResult.error) {
      logger.warn(`[getActiveOrdersAction] LLM indicated error: ${llmResult.error}`);
    }

    const marketSlug = llmResult.market;
    const assetId = llmResult.assetId;

    const apiParams: OfficialOpenOrdersParams = {};
    if (marketSlug) apiParams.market = marketSlug;
    if (assetId) apiParams.asset_id = assetId;

    logger.info(
      `[getActiveOrdersAction] Fetching active orders with params: ${JSON.stringify(apiParams)}`
    );

    try {
      const client = await initializeClobClientWithCreds(runtime) as ClobClient;
      const fetchParams: GetOpenOrdersParams = {
        market: apiParams.market,
        asset_id: apiParams.asset_id,
      };
      const orders: OpenOrder[] = await client.getOpenOrders(fetchParams);

      let responseText = `📋 **Your Active Orders on Polymarket:**\n\n`;

      if (orders && orders.length > 0) {
        responseText += `Found ${orders.length} active order(s):\n\n`;
        orders.forEach((order: OpenOrder, index: number) => {
          const sideEmoji = order.side === 'BUY' ? '🟢' : '🔴';
          responseText += `**${index + 1}. Order ID: ${order.id}** ${sideEmoji}\n`;
          responseText += `   • **Status**: ${order.status}\n`;
          responseText += `   • **Side**: ${order.side}\n`;
          responseText += `   • **Type**: ${order.order_type || 'N/A'}\n`;
          responseText += `   • **Price**: $${parseFloat(order.price).toFixed(4)}\n`;
          responseText += `   • **Original Size**: ${order.original_size}\n`;
          responseText += `   • **Size Matched**: ${order.size_matched}\n`;
          responseText += `   • **Created At**: ${order.created_at ? new Date(order.created_at).toLocaleString() : 'N/A'}\n`;
          responseText += `   • **Expiration**: ${order.expiration && order.expiration !== '0' ? new Date(parseInt(order.expiration) * 1000).toLocaleString() : 'None (GTC)'}\n`;
          responseText += `\n`;
        });
      } else {
        responseText += `You have no active orders.\n`;
        if (marketSlug) responseText += ` (Filtered by market: ${marketSlug})`;
        if (assetId) responseText += ` (Filtered by asset_id: ${assetId})`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['GET_ACTIVE_ORDERS'],
        data: {
          orders,
          filters: apiParams,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[getActiveOrdersAction] Error fetching active orders:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error fetching active orders**: ${errorMessage}`,
        actions: ['GET_ACTIVE_ORDERS'],
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
      { name: '{{user1}}', content: { text: 'Show my active orders on Polymarket.' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching your active orders from Polymarket...',
          action: 'POLYMARKET_GET_ACTIVE_ORDERS',
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: "What are my open orders for 'will-ai-breakthrough' via Polymarket?" } },
      {
        name: '{{user2}}',
        content: {
          text: "Fetching your active orders for the 'will-ai-breakthrough' market on Polymarket...",
          action: 'POLYMARKET_GET_ACTIVE_ORDERS',
        },
      },
    ],
  ],
};
