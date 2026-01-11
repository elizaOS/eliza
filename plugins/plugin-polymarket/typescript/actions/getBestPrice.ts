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
import { initializeClobClient } from '../utils/clobClient';
import { getBestPriceTemplate } from '../templates';
import type { ClobClient } from '@polymarket/clob-client';

interface LLMBestPriceResult {
  tokenId?: string;
  side?: string;
  error?: string;
}

interface PriceResult {
  price: string;
}

/**
 * Get Best Price Action for Polymarket.
 * Returns the current best price (top of book) for a given token and side.
 */
export const getBestPriceAction: Action = {
  name: 'POLYMARKET_GET_BEST_PRICE',
  similes: ['GET_TOP_OF_BOOK', 'BEST_BID', 'BEST_ASK', 'SHOW_BEST_PRICE'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Gets the current best price (top of book) for a specified token ID and side (BUY/SELL) on Polymarket.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(`[getBestPriceAction] Validate called for message: "${message.content?.text}"`);
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getBestPriceAction] CLOB_API_URL is required.');
      return false;
    }
    logger.info('[getBestPriceAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getBestPriceAction] Handler called!');

    let llmResult: LLMBestPriceResult = {};
    try {
      const result = await callLLMWithTimeout<LLMBestPriceResult>(
        runtime,
        state,
        getBestPriceTemplate,
        'getBestPriceAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[getBestPriceAction] LLM result: ${JSON.stringify(llmResult)}`);

      if (llmResult.error || !llmResult.tokenId || !llmResult.side) {
        throw new Error(llmResult.error || 'Token ID and side not found in LLM result.');
      }
    } catch (error) {
      logger.warn('[getBestPriceAction] LLM extraction failed, trying regex fallback', error);
      const text = message.content?.text || '';

      const tokenIdMatch = text.match(
        /(?:token|tokenId|asset|id|for)\s*[:=#]?\s*([0-9a-zA-Z_\-]+)/i
      );
      const sideMatch = text.match(/\b(buy|bid|sell|ask)\b/i);

      if (tokenIdMatch && sideMatch) {
        llmResult.tokenId = tokenIdMatch[1];
        llmResult.side = sideMatch[1].toUpperCase();
        if (llmResult.side === 'ASK') llmResult.side = 'SELL';
        if (llmResult.side === 'BID') llmResult.side = 'BUY';
        logger.info(
          `[getBestPriceAction] Regex extracted: tokenId=${llmResult.tokenId}, side=${llmResult.side}`
        );
      } else {
        const errorMessage = 'Please specify a Token ID and a side (BUY/SELL) to get the best price.';
        logger.error(`[getBestPriceAction] Extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ['GET_BEST_PRICE'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
    }

    const tokenId = llmResult.tokenId!;
    const side = llmResult.side!.toUpperCase();

    logger.info(`[getBestPriceAction] Fetching best ${side} price for token: ${tokenId}`);

    try {
      const client = await initializeClobClient(runtime) as ClobClient;
      const priceResult: PriceResult = await client.getPrice(tokenId, side);

      let responseText = `💰 **Best ${side} Price for Token ${tokenId}**:\n\n`;
      if (priceResult?.price) {
        responseText += `• **Price**: $${parseFloat(priceResult.price).toFixed(4)}\n`;
      } else {
        responseText += `Could not retrieve best price. Order book might be empty for this side.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['GET_BEST_PRICE'],
        data: {
          tokenId,
          side,
          price: priceResult?.price,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error(
        `[getBestPriceAction] Error getting best price for ${tokenId} ${side}:`,
        error
      );
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error getting best price**: ${errorMessage}`,
        actions: ['GET_BEST_PRICE'],
        data: {
          tokenId,
          side,
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
        content: { text: 'What is the best buy price for token xyz123 on Polymarket?' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching the best buy price for token xyz123...',
          action: 'POLYMARKET_GET_BEST_PRICE',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Get the best ask for token 0xabc789 via Polymarket.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Looking up the best sell/ask price for token 0xabc789...',
          action: 'POLYMARKET_GET_BEST_PRICE',
        },
      },
    ],
  ],
};
