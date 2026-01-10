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
import { getOrderDetailsTemplate } from '../templates';
import type { OrderSide, OrderStatus } from '../types';

interface OfficialOpenOrder {
  order_id: string;
  user_id: string;
  market_id: string;
  token_id: string;
  side: OrderSide;
  type: string;
  status: string;
  price: string;
  size: string;
  filled_size: string;
  fees_paid?: string;
  created_at: string;
  updated_at: string;
  is_cancelled?: boolean;
  is_taker?: boolean;
  is_active_order?: boolean;
  error_code?: string | null;
  error_message?: string | null;
}

/**
 * Get order details by ID action for Polymarket.
 * Fetches detailed information for a specific order.
 */
export const getOrderDetailsAction: Action = {
  name: 'POLYMARKET_GET_ORDER_DETAILS',
  similes: ['ORDER_DETAILS', 'GET_ORDER', 'FETCH_ORDER', 'SHOW_ORDER_INFO', 'ORDER_STATUS'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description: 'Retrieves details for a specific order by its ID.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[getOrderDetailsAction] Validate called for message: "${message.content?.text}"`);
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
      logger.warn('[getOrderDetailsAction] CLOB_API_URL is required');
      return false;
    }
    if (!privateKey) {
      logger.warn(
        '[getOrderDetailsAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.'
      );
      return false;
    }
    if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
      const missing = [];
      if (!clobApiKey) missing.push('CLOB_API_KEY');
      if (!clobApiSecret) missing.push('CLOB_API_SECRET or CLOB_SECRET');
      if (!clobApiPassphrase) missing.push('CLOB_API_PASSPHRASE or CLOB_PASS_PHRASE');
      logger.warn(
        `[getOrderDetailsAction] Missing required API credentials for L2 authentication: ${missing.join(', ')}.`
      );
      return false;
    }
    logger.info('[getOrderDetailsAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getOrderDetailsAction] Handler called!');

    let orderId: string | undefined;
    try {
      const llmResult = await callLLMWithTimeout<{ orderId?: string; error?: string }>(
        runtime,
        state,
        getOrderDetailsTemplate,
        'getOrderDetailsAction'
      );
      logger.info(`[getOrderDetailsAction] LLM result: ${JSON.stringify(llmResult)}`);
      if (llmResult?.error || !llmResult?.orderId) {
        throw new Error(llmResult?.error || 'Order ID not found in LLM result.');
      }
      orderId = llmResult.orderId;
    } catch (error) {
      logger.warn('[getOrderDetailsAction] LLM extraction failed, trying regex fallback');
      const text = message.content?.text || '';
      const orderIdRegex = /(?:order|ID)[:\s#]?([0-9a-zA-Z_\-]+(?:0x[0-9a-fA-F]+)?)/i;
      const match = text.match(orderIdRegex);
      if (match && match[1]) {
        orderId = match[1];
      } else {
        const errorMessage = 'Please specify an Order ID to get details.';
        logger.error(`[getOrderDetailsAction] Order ID extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ['POLYMARKET_GET_ORDER_DETAILS'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
    }

    if (!orderId) {
      const errorMessage = 'Order ID is missing after extraction attempts.';
      logger.error(`[getOrderDetailsAction] ${errorMessage}`);
      const errorContent: Content = {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ['POLYMARKET_GET_ORDER_DETAILS'],
        data: { error: errorMessage },
      };
      if (callback) await callback(errorContent);
      throw new Error(errorMessage);
    }

    logger.info(`[getOrderDetailsAction] Attempting to fetch details for Order ID: ${orderId}`);

    try {
      const client = (await initializeClobClientWithCreds(runtime)) as ClobClient;
      const order: any = await client.getOrder(orderId);

      if (!order) {
        logger.warn(`[getOrderDetailsAction] Order not found for ID: ${orderId}`);
        const notFoundContent: Content = {
          text: `🤷 **Order Not Found**: No order exists with the ID \`${orderId}\`.`,
          actions: ['POLYMARKET_GET_ORDER_DETAILS'],
          data: { error: 'Order not found', orderId, timestamp: new Date().toISOString() },
        };
        if (callback) await callback(notFoundContent);
        return notFoundContent;
      }

      const displayOrder = order as OfficialOpenOrder;

      let responseText = `📦 **Order Details: ${displayOrder.order_id}**\n\n`;
      responseText += `  **Market ID**: ${displayOrder.market_id}\n`;
      responseText += `  **Token ID**: ${displayOrder.token_id}\n`;
      responseText += `  **Side**: ${displayOrder.side}, **Type**: ${displayOrder.type}\n`;
      responseText += `  **Status**: ${displayOrder.status}\n`;
      responseText += `  **Price**: ${displayOrder.price}, **Size**: ${displayOrder.size}\n`;
      responseText += `  **Filled Size**: ${displayOrder.filled_size}\n`;
      if (displayOrder.fees_paid) responseText += `  **Fees Paid**: ${displayOrder.fees_paid}\n`;
      responseText += `  **Created**: ${new Date(displayOrder.created_at).toLocaleString()}\n`;
      responseText += `  **Updated**: ${new Date(displayOrder.updated_at).toLocaleString()}\n`;
      if (displayOrder.is_cancelled !== undefined)
        responseText += `  **Cancelled**: ${displayOrder.is_cancelled ? 'Yes' : 'No'}\n`;
      if (displayOrder.error_message)
        responseText += `  **Error**: ${displayOrder.error_message}\n`;

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_ORDER_DETAILS'],
        data: { order: displayOrder, timestamp: new Date().toISOString() },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error(`[getOrderDetailsAction] Error fetching order ${orderId}:`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error fetching order details for ${orderId}**: ${errorMessage}`,
        actions: ['POLYMARKET_GET_ORDER_DETAILS'],
        data: { error: errorMessage, orderId, timestamp: new Date().toISOString() },
      };
      if (callback) await callback(errorContent);
      throw error;
    }
  },

  examples: [
    [
      { name: '{{user1}}', content: { text: 'Get details for order 0x123abcxyz via Polymarket' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching details for order 0x123abcxyz via Polymarket.',
          action: 'POLYMARKET_GET_ORDER_DETAILS',
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'order status myOrderID_123 via Polymarket' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me get the status for order myOrderID_123 via Polymarket.',
          action: 'POLYMARKET_GET_ORDER_DETAILS',
        },
      },
    ],
  ],
};
