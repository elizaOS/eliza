import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
  ModelType,
  composePromptFromState,
} from '@elizaos/core';
import { callLLMWithTimeout } from '../utils/llmHelpers';
import { initializeClobClient } from '../utils/clobClient';
import { getBestPriceTemplate } from '../templates';

interface BestPriceParams {
  tokenId: string;
  side: string;
}

/**
 * Get best bid/ask price for a market token action for Polymarket
 * Fetches the best price for a specific token and side (buy/sell)
 */
export const getBestPriceAction: Action = {
  name: 'GET_BEST_PRICE',
  similes: [
    'BEST_PRICE',
    'GET_PRICE',
    'SHOW_PRICE',
    'FETCH_PRICE',
    'PRICE_DATA',
    'MARKET_PRICE',
    'BID_PRICE',
    'ASK_PRICE',
    'BEST_BID',
    'BEST_ASK',
    'GET_BEST_PRICE',
    'SHOW_BEST_PRICE',
    'FETCH_BEST_PRICE',
    'PRICE_CHECK',
    'CHECK_PRICE',
    'PRICE_LOOKUP',
    'TOKEN_PRICE',
    'MARKET_RATE',
  ],
  description: 'Get the best bid or ask price for a specific market token',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[getBestPriceAction] Validate called for message: "${message.content?.text}"`);

    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getBestPriceAction] CLOB_API_URL is required but not provided');
      return false;
    }

    logger.info('[getBestPriceAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getBestPriceAction] Handler called!');

    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      const errorMessage = 'CLOB_API_URL is required in configuration.';
      logger.error(`[getBestPriceAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['GET_BEST_PRICE'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let tokenId: string;
    let side: string;

    try {
      // Use LLM to extract parameters
      const llmResult = await callLLMWithTimeout<{
        tokenId?: string;
        side?: string;
        error?: string;
      }>(runtime, state, getBestPriceTemplate, 'getBestPriceAction');

      logger.info('[getBestPriceAction] LLM result:', JSON.stringify(llmResult));

      if (llmResult?.error) {
        throw new Error('Token ID or side not found');
      }

      tokenId = llmResult?.tokenId || '';
      side = llmResult?.side?.toLowerCase() || '';

      if (!tokenId || !side) {
        throw new Error('Token ID or side not found');
      }
    } catch (error) {
      logger.warn('[getBestPriceAction] LLM extraction failed, trying regex fallback');

      // Fallback to regex extraction
      const text = message.content?.text || '';

      // Extract token ID - look for patterns like "token 123456", "market 456789", or just numbers
      const tokenMatch = text.match(/(?:token|market|id)\s+([a-zA-Z0-9]+)|([0-9]{5,})/i);
      tokenId = tokenMatch?.[1] || tokenMatch?.[2] || '';

      // Extract side - look for buy/sell indicators
      const sideMatch = text.match(/\b(buy|sell|bid|ask)\b/i);
      if (sideMatch) {
        const matched = sideMatch[1].toLowerCase();
        // Map ask -> buy, bid -> sell (common trading terminology)
        side = matched === 'ask' ? 'buy' : matched === 'bid' ? 'sell' : matched;
      } else {
        side = 'buy'; // Default to buy
      }

      if (!tokenId) {
        const errorMessage = 'Please provide a token ID to get the price for.';
        logger.error(`[getBestPriceAction] Token ID extraction failed`);

        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}

Please provide a token ID in your request. Examples:
• "Get best price for token 123456 on buy side"
• "What's the sell price for market token 789012?"
• "Show me the best bid for 456789"`,
          actions: ['POLYMARKET_GET_BEST_PRICE'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        throw new Error(errorMessage);
      }
    }

    // Validate side parameter
    if (!['buy', 'sell'].includes(side)) {
      side = 'buy'; // Default to buy if invalid
    }

    try {
      const client = await initializeClobClient(runtime);
      const priceResponse = await client.getPrice(tokenId, side);

      if (!priceResponse || !priceResponse.price) {
        throw new Error(`No price data available for token ${tokenId}`);
      }

      const priceValue = parseFloat(priceResponse.price);
      const formattedPrice = priceValue.toFixed(4);
      const percentagePrice = (priceValue * 100).toFixed(2);

      const sideText = side === 'buy' ? 'ask (buy)' : 'bid (sell)';

      const responseText = `💰 **Best ${sideText.charAt(0).toUpperCase() + sideText.slice(1)} Price for Token ${tokenId}**

**Price**: $${formattedPrice} (${percentagePrice}%)
**Side**: ${sideText}
**Token ID**: ${tokenId}

${
  side === 'buy'
    ? 'This is the best price you would pay to buy this token.'
    : 'This is the best price you would receive when selling this token.'
}`;

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_BEST_PRICE'],
        data: {
          tokenId,
          side,
          price: priceResponse.price,
          formattedPrice,
          percentagePrice,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      logger.error('[getBestPriceAction] Error fetching price:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';

      const errorContent: Content = {
        text: `❌ **Error getting best price**: ${errorMessage}

Please check:
• The token ID is valid and exists
• CLOB_API_URL is correctly configured
• Network connectivity is available

**Token ID**: \`${tokenId}\`
**Side**: \`${side}\``,
        actions: ['POLYMARKET_GET_BEST_PRICE'],
        data: {
          error: errorMessage,
          tokenId,
          side,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw error;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get best price for token 123456 on buy side via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll fetch the best buy price for that token via Polymarket.",
          actions: ['POLYMARKET_GET_BEST_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: "What's the sell price for market token 789012 via Polymarket?",
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me get the best sell price for that token via Polymarket.',
          actions: ['POLYMARKET_GET_BEST_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show me the best bid for 456789 via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting the best bid price for token 456789 via Polymarket.',
          actions: ['POLYMARKET_GET_BEST_PRICE'],
        },
      },
    ],
  ],
};
