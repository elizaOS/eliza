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
import { getOrderDetailsTemplate } from '../templates';
import type { ClobClient } from '@polymarket/clob-client';
import type { DetailedOrder } from '../types';

interface LLMOrderDetailsResult {
  orderId?: string;
  error?: string;
}

/**
 * Get Order Details Action for Polymarket.
 * Retrieves detailed information about a specific order by its ID.
 */
export const getOrderDetailsAction: Action = {
  name: 'POLYMARKET_GET_ORDER_DETAILS',
  similes: ['ORDER_INFO', 'VIEW_ORDER', 'SHOW_ORDER', 'ORDER_STATUS'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Retrieves detailed information about a specific order by its ID on Polymarket.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
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
      logger.warn('[getOrderDetailsAction] CLOB_API_URL is required.');
      return false;
    }
    if (!privateKey) {
      logger.warn(
        '[getOrderDetailsAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.'
      );
      return false;
    }
    if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
      const missing: string[] = [];
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
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getOrderDetailsAction] Handler called!');

    let llmResult: LLMOrderDetailsResult = {};
    try {
      const result = await callLLMWithTimeout<LLMOrderDetailsResult>(
        runtime,
        state,
        getOrderDetailsTemplate,
        'getOrderDetailsAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[getOrderDetailsAction] LLM result: ${JSON.stringify(llmResult)}`);

      if (llmResult.error || !llmResult.orderId) {
        throw new Error(llmResult.error || 'Order ID not found in LLM result.');
      }
    } catch (error) {
      logger.warn('[getOrderDetailsAction] LLM extraction failed, trying regex fallback', error);
      const text = message.content?.text || '';

      const orderIdMatch = text.match(
        /(?:order|orderId|id|details\s+for)\s*[:=#]?\s*([0-9a-zA-Z_\-]+)/i
      );

      if (orderIdMatch) {
        llmResult.orderId = orderIdMatch[1];
        logger.info(
          `[getOrderDetailsAction] Regex extracted orderId: ${llmResult.orderId}`
        );
      } else {
        const errorMessage = 'Please specify an Order ID to get order details.';
        logger.error(`[getOrderDetailsAction] Extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ['GET_ORDER_DETAILS'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
    }

    const orderId = llmResult.orderId!;

    logger.info(`[getOrderDetailsAction] Fetching details for order: ${orderId}`);

    try {
      const client = await initializeClobClientWithCreds(runtime) as ClobClient;
      const order: DetailedOrder = await client.getOrder(orderId);

      let responseText = `📋 **Order Details for ${orderId}**:\n\n`;

      if (order) {
        const sideEmoji = order.side === 'BUY' ? '🟢' : '🔴';
        responseText += `• **Order ID**: \`${order.id}\` ${sideEmoji}\n`;
        responseText += `• **Status**: ${order.status}\n`;
        responseText += `• **Market**: ${order.market || 'N/A'}\n`;
        responseText += `• **Asset ID**: \`${order.asset_id || 'N/A'}\`\n`;
        responseText += `• **Side**: ${order.side}\n`;
        responseText += `• **Type**: ${order.order_type || 'LIMIT'}\n`;
        responseText += `• **Price**: $${parseFloat(order.price).toFixed(4)}\n`;
        responseText += `• **Original Size**: ${order.original_size}\n`;
        responseText += `• **Size Matched**: ${order.size_matched}\n`;
        responseText += `• **Remaining Size**: ${parseFloat(order.original_size) - parseFloat(order.size_matched)}\n`;
        if (order.created_at) {
          responseText += `• **Created**: ${new Date(order.created_at).toLocaleString()}\n`;
        }
        if (order.expiration && order.expiration !== '0') {
          responseText += `• **Expiration**: ${new Date(parseInt(order.expiration) * 1000).toLocaleString()}\n`;
        } else {
          responseText += `• **Expiration**: None (GTC)\n`;
        }
        if (order.associate_trades && order.associate_trades.length > 0) {
          responseText += `• **Associated Trades**: ${order.associate_trades.length}\n`;
        }
      } else {
        responseText += `Order not found or you do not have access to view it.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['GET_ORDER_DETAILS'],
        data: {
          order,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error(`[getOrderDetailsAction] Error getting order ${orderId}:`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error getting order details**: ${errorMessage}`,
        actions: ['GET_ORDER_DETAILS'],
        data: {
          orderId,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        },
      };
      if (callback) await callback(errorContent);
      throw error;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Show me the details for order abc123 on Polymarket.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching details for order abc123 on Polymarket...',
          action: 'POLYMARKET_GET_ORDER_DETAILS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'What is the status of my order 0xdef456 via Polymarket?' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Looking up order 0xdef456 on Polymarket...',
          action: 'POLYMARKET_GET_ORDER_DETAILS',
        },
      },
    ],
  ],
};
