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
import { checkOrderScoringTemplate } from '../templates';
import type { AreOrdersScoringResponse } from '../types';

// This is the expected parameter structure for the official client's areOrdersScoring method
interface OfficialOrdersScoringParams {
  orderIds: string[];
}

// This is the expected response structure from the official client's areOrdersScoring method
// type OfficialOrdersScoringResponse = Record<string, boolean>; // This is same as our AreOrdersScoringResponse

/**
 * Check if an order is scoring (eligible for rewards) action for Polymarket.
 */
export const checkOrderScoringAction: Action = {
  name: 'POLYMARKET_CHECK_ORDER_SCORING',
  similes: ['ORDERS_ELIGIBLE_FOR_REWARDS', 'SCORING_STATUS', 'ARE_MY_ORDERS_SCORING'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description: 'Checks if any of the authenticated user orders are eligible for rewards (scoring).',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(
      `[checkOrderScoringAction] Validate called for message: "${message.content?.text}"`
    );
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
      logger.warn('[checkOrderScoringAction] CLOB_API_URL is required.');
      return false;
    }
    if (!privateKey) {
      logger.warn(
        '[checkOrderScoringAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.'
      );
      return false;
    }
    if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
      const missing = [];
      if (!clobApiKey) missing.push('CLOB_API_KEY');
      if (!clobApiSecret) missing.push('CLOB_API_SECRET or CLOB_SECRET');
      if (!clobApiPassphrase) missing.push('CLOB_API_PASSPHRASE or CLOB_PASS_PHRASE');
      logger.warn(
        `[checkOrderScoringAction] Missing required API credentials for L2 authentication: ${missing.join(', ')}.`
      );
      return false;
    }
    logger.info('[checkOrderScoringAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[checkOrderScoringAction] Handler called!');

    let llmResult: { orderIds?: string[]; error?: string } = {};
    try {
      llmResult = await callLLMWithTimeout<typeof llmResult>(
        runtime,
        state,
        checkOrderScoringTemplate,
        'checkOrderScoringAction'
      );
      logger.info(`[checkOrderScoringAction] LLM result: ${JSON.stringify(llmResult)}`);

      if (llmResult.error || !llmResult.orderIds || llmResult.orderIds.length === 0) {
        throw new Error(llmResult.error || 'Order IDs not found in LLM result.');
      }
    } catch (error) {
      logger.warn('[checkOrderScoringAction] LLM extraction failed, trying regex fallback', error);
      const text = message.content?.text || '';
      const orderIdRegex =
        /(?:order|ID|orders|IDs|check\s+scoring\s+for)[:\s#]?([0-9a-zA-Z_,\s\-_]+(?:0x[0-9a-fA-F]+)?)/gi;
      let matches;
      const extractedIds: string[] = [];
      while ((matches = orderIdRegex.exec(text)) !== null) {
        matches[1].split(/[\s,]+/).forEach((id) => {
          if (id.trim()) extractedIds.push(id.trim());
        });
      }

      if (extractedIds.length > 0) {
        llmResult.orderIds = extractedIds.filter((id, index, self) => self.indexOf(id) === index); // Unique IDs
      } else {
        const errorMessage = 'Please specify one or more Order IDs to check scoring status.';
        logger.error(`[checkOrderScoringAction] Order ID extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ['CHECK_ORDER_SCORING'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
      logger.info(
        `[checkOrderScoringAction] Regex extracted Order IDs: ${JSON.stringify(llmResult.orderIds)}`
      );
    }

    const orderIdsToScore = llmResult.orderIds!;
    const apiParams: OfficialOrdersScoringParams = { orderIds: orderIdsToScore };

    logger.info(
      `[checkOrderScoringAction] Checking scoring for Order IDs: ${orderIdsToScore.join(', ')}`
    );

    try {
      const client = (await initializeClobClientWithCreds(runtime)) as ClobClient;
      // The official client's areOrdersScoring returns Promise<OrdersScoring>
      // where OrdersScoring is likely Record<string, boolean>
      const scoringResponse: AreOrdersScoringResponse = await client.areOrdersScoring(apiParams);

      let responseText = `📊 **Order Scoring Status**:\n\n`;
      if (Object.keys(scoringResponse).length > 0) {
        for (const [orderId, isScoring] of Object.entries(scoringResponse)) {
          responseText += `  • **Order ${orderId}**: ${isScoring ? '✅ Scoring' : '❌ Not Scoring'}\n`;
        }
      } else {
        responseText += 'Could not retrieve scoring status or no valid order IDs provided.';
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['CHECK_ORDER_SCORING'],
        data: {
          request: apiParams,
          response: scoringResponse,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error(
        `[checkOrderScoringAction] Error checking order scoring for IDs ${orderIdsToScore.join(', ')}:`,
        error
      );
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error checking order scoring**: ${errorMessage}`,
        actions: ['CHECK_ORDER_SCORING'],
        data: {
          error: errorMessage,
          orderIds: orderIdsToScore,
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
        content: { text: 'Are orders 123xyz and abc789 scoring via Polymarket?' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Checking scoring status for orders 123xyz and abc789 via Polymarket.',
          action: 'CHECK_ORDER_SCORING',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Is my order 0xOrderMain scoring rewards via Polymarket?' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me check if your order 0xOrderMain is scoring rewards via Polymarket.',
          action: 'POLYMARKET_CHECK_ORDER_SCORING',
        },
      },
    ],
  ],
};
