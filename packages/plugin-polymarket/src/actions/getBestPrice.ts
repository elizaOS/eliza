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

// Define the response structure for the callback data property
export interface BestPriceResponseData {
  tokenId: string;
  side: 'buy' | 'sell';
  price: string;
  formattedPrice: string;
  percentagePrice: string;
  timestamp: string;
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

Please provide a token ID in your request. Here are comprehensive examples:

**💰 BASIC PRICE QUERIES:**
• "Get best price for token 123456 on buy side"
• "What's the sell price for market token 789012?"
• "Show me the best bid for 456789"
• "Best ask price for token 321654"
• "Price for buying token 987654"
• "Selling price for 555666"

**⚡ QUICK PRICE FORMATS:**
• "Price 123456 buy"
• "Sell price 789012"
• "Ask 456789"
• "Bid 321654"
• "Buy price for 987654"
• "Token 555666 sell"

**🔍 DETAILED PRICE QUERIES:**
• "Show me the best buy price for token 123456"
• "Get the current sell price for market 789012"
• "What's the best ask price for token 456789?"
• "Display bid price for market token 321654"
• "Current buying price for prediction token 987654"
• "Market sell price for token 555666"

**📊 SIDE-SPECIFIC QUERIES:**
• "Buy side price for token 123456"
• "Sell side price for market 789012"
• "Ask price (buy) for token 456789"
• "Bid price (sell) for token 321654"
• "Long price for 987654"
• "Short price for 555666"

**🎯 CONTEXT-AWARE QUERIES:**
• "Best price to buy Bitcoin prediction token 123456"
• "Selling price for election market 789012"
• "Price to buy YES on sports bet 456789"
• "NO token sell price for 321654"
• "Current crypto market price 987654"

**📋 STRUCTURED QUERIES:**
• "GET_BEST_PRICE token: 123456, side: buy"
• "Price { tokenId: 789012, side: sell }"
• "Best price = 456789 buy"
• "Show price_token: 321654 sell"

**💡 What You'll See:**
Price information includes:
• Current best price in USD
• Percentage representation (0-100%)
• Buy vs. sell side pricing
• Real-time market data
• Price explanations

**📈 Trading Context:**
• **Buy/Ask Price**: What you pay to purchase
• **Sell/Bid Price**: What you receive when selling
• **Side**: Buy (long) or Sell (short) position
• **Real-time**: Prices update with market conditions`,
          actions: ['GET_BEST_PRICE'],
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
        actions: ['GET_BEST_PRICE'],
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
        actions: ['GET_BEST_PRICE'],
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
          text: 'Get best price for token 123456 on buy side',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll fetch the best buy price for that token.",
          actions: ['GET_BEST_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: "What's the sell price for market token 789012?",
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Let me get the best sell price for that token.',
          actions: ['GET_BEST_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show me the best bid for 456789',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting the best bid price for token 456789.',
          actions: ['GET_BEST_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Best ask price for token 321654',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get the best ask (buy) price for token 321654.",
          actions: ['GET_BEST_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Price for buying token 987654',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting the current buying price for token 987654.',
          actions: ['GET_BEST_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Selling price for 555666',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll fetch the selling price for token 555666.",
          actions: ['GET_BEST_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Price 123456 buy',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting buy price for token 123456.',
          actions: ['GET_BEST_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Sell price 789012',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching sell price for token 789012.',
          actions: ['GET_BEST_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Current crypto market price 456789',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting the current market price for crypto token 456789.',
          actions: ['GET_BEST_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Best price to buy Bitcoin prediction token 123456',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll get the best price for buying the Bitcoin prediction token.",
          actions: ['GET_BEST_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Long price for 987654',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting the long (buy) price for token 987654.',
          actions: ['GET_BEST_PRICE'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Short price for 321654',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Getting the short (sell) price for token 321654.',
          actions: ['GET_BEST_PRICE'],
        },
      },
    ],
  ],
};
