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
import { orderTemplate } from '../templates';
import { OrderSide, OrderType } from '../types';
import { ClobClient, Side } from '@polymarket/clob-client';
import { ethers } from 'ethers';

interface PlaceOrderParams {
  tokenId: string;
  side: string;
  price: number;
  size: number;
  orderType?: string;
  feeRateBps?: string;
  marketName?: string;
}

/**
 * Place order action for Polymarket
 * Creates and places both limit and market orders
 */
export const placeOrderAction: Action = {
  name: 'PLACE_ORDER',
  similes: [
    'CREATE_ORDER',
    'PLACE_ORDER',
    'BUY_TOKEN',
    'SELL_TOKEN',
    'LIMIT_ORDER',
    'MARKET_ORDER',
    'TRADE',
    'ORDER',
    'BUY',
    'SELL',
    'PURCHASE',
    'PLACE_BUY',
    'PLACE_SELL',
    'CREATE_BUY_ORDER',
    'CREATE_SELL_ORDER',
    'SUBMIT_ORDER',
    'EXECUTE_ORDER',
    'MAKE_ORDER',
    'PLACE_TRADE',
  ],
  description: 'Create and place limit or market orders on Polymarket',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[placeOrderAction] Validate called for message: "${message.content?.text}"`);

    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[placeOrderAction] CLOB_API_URL is required but not provided');
      return false;
    }

    logger.info('[placeOrderAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[placeOrderAction] Handler called!');

    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      const errorMessage = 'CLOB_API_URL is required in configuration.';
      logger.error(`[placeOrderAction] Configuration error: ${errorMessage}`);
      const errorContent: Content = {
        text: errorMessage,
        actions: ['PLACE_ORDER'],
        data: { error: errorMessage },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }

    let tokenId: string;
    let side: string;
    let price: number;
    let size: number;
    let orderType: string = 'GTC'; // Default to Good Till Cancelled
    let feeRateBps: string = '0'; // Default fee

    try {
      // Use LLM to extract parameters
      const llmResult = await callLLMWithTimeout<PlaceOrderParams & { error?: string }>(
        runtime,
        state,
        orderTemplate,
        'placeOrderAction'
      );

      logger.info('[placeOrderAction] LLM result:', JSON.stringify(llmResult));

      if (llmResult?.error) {
        throw new Error('Required order parameters not found');
      }

      tokenId = llmResult?.tokenId || '';
      side = llmResult?.side?.toUpperCase() || '';
      price = llmResult?.price || 0;
      size = llmResult?.size || 0;
      orderType = llmResult?.orderType?.toUpperCase() || 'GTC';
      feeRateBps = llmResult?.feeRateBps || '0';

      // Handle market name lookup
      if (tokenId === 'MARKET_NAME_LOOKUP' && llmResult?.marketName) {
        logger.info(`[placeOrderAction] Market name lookup requested: ${llmResult.marketName}`);
        throw new Error(
          `Market name lookup not yet implemented. Please provide a specific token ID. You requested: "${llmResult.marketName}"`
        );
      }

      if (!tokenId || !side || price <= 0 || size <= 0) {
        throw new Error('Invalid order parameters');
      }
    } catch (error) {
      logger.warn('[placeOrderAction] LLM extraction failed, trying regex fallback');

      // Fallback to regex extraction
      const text = message.content?.text || '';

      // Extract token ID
      const tokenMatch = text.match(/(?:token|market|id)\s+([a-zA-Z0-9]+)|([0-9]{5,})/i);
      tokenId = tokenMatch?.[1] || tokenMatch?.[2] || '';

      // Extract side
      const sideMatch = text.match(/\b(buy|sell|long|short)\b/i);
      side = sideMatch?.[1]?.toUpperCase() || 'BUY';

      // Extract price
      const priceMatch = text.match(/(?:price|at|for)\s*\$?([0-9]*\.?[0-9]+)/i);
      price = priceMatch ? parseFloat(priceMatch[1]) : 0;

      // Extract size
      const sizeMatch = text.match(
        /(?:size|amount|quantity)\s*([0-9]*\.?[0-9]+)|([0-9]*\.?[0-9]+)\s*(?:shares|tokens)/i
      );
      size = sizeMatch ? parseFloat(sizeMatch[1] || sizeMatch[2]) : 0;

      // Extract order type
      const orderTypeMatch = text.match(/\b(GTC|FOK|GTD|FAK|limit|market)\b/i);
      if (orderTypeMatch) {
        const matched = orderTypeMatch[1].toUpperCase();
        orderType = matched === 'LIMIT' ? 'GTC' : matched === 'MARKET' ? 'FOK' : matched;
      }

      if (!tokenId || price <= 0 || size <= 0) {
        const errorMessage = 'Please provide valid order parameters: token ID, price, and size.';
        logger.error(`[placeOrderAction] Parameter extraction failed`);

        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}

Please provide order details in your request. Examples:
• "Buy 100 tokens of 123456 at $0.50 limit order"
• "Sell 50 shares of token 789012 at $0.75"
• "Place market order to buy 25 tokens of 456789"

**Required parameters:**
- Token ID (market identifier)
- Side (buy/sell)
- Price (in USD, 0-1.0 for prediction markets)
- Size (number of shares)

**Optional parameters:**
- Order type (GTC/limit, FOK/market, GTD, FAK)
- Fee rate (in basis points)`,
          actions: ['PLACE_ORDER'],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        throw new Error(errorMessage);
      }
    }

    // Validate parameters
    if (!['BUY', 'SELL'].includes(side)) {
      side = 'BUY'; // Default to buy
    }

    if (price > 1.0) {
      price = price / 100; // Convert percentage to decimal if needed
    }

    if (!['GTC', 'FOK', 'GTD', 'FAK'].includes(orderType)) {
      orderType = 'GTC'; // Default to GTC
    }

    try {
      const client = await initializeClobClient(runtime);

      // Create order arguments matching the official ClobClient interface
      const orderArgs = {
        tokenID: tokenId, // Official package expects tokenID (capital ID)
        price,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
        size,
        feeRateBps: parseFloat(feeRateBps), // Convert to number
      };

      logger.info(`[placeOrderAction] Creating order with args:`, orderArgs);

      // Create the signed order with enhanced error handling
      let signedOrder;
      try {
        signedOrder = await client.createOrder(orderArgs);
        logger.info(`[placeOrderAction] Order created successfully`);
      } catch (createError) {
        logger.error(`[placeOrderAction] Error creating order:`, createError);

        // Check for specific error types
        if (createError instanceof Error) {
          if (createError.message.includes('minimum_tick_size')) {
            throw new Error(
              `Invalid market data: The market may not exist or be inactive. Please verify the token ID is correct and the market is active.`
            );
          }
          if (createError.message.includes('undefined is not an object')) {
            throw new Error(
              `Market data unavailable: The token ID may be invalid or the market may be closed.`
            );
          }
        }
        throw createError;
      }

      // Post the order with enhanced error handling
      let orderResponse;
      try {
        orderResponse = await client.postOrder(signedOrder, orderType as OrderType);
        logger.info(`[placeOrderAction] Order posted successfully`);
      } catch (postError) {
        logger.error(`[placeOrderAction] Error posting order:`, postError);
        throw new Error(
          `Failed to submit order: ${postError instanceof Error ? postError.message : 'Unknown error'}`
        );
      }

      // Format response based on success
      let responseText: string;
      let responseData: any;

      if (orderResponse.success) {
        const sideText = side.toLowerCase();
        const orderTypeText =
          orderType === 'GTC' ? 'limit' : orderType === 'FOK' ? 'market' : orderType.toLowerCase();
        const totalValue = (price * size).toFixed(4);

        responseText = `✅ **Order Placed Successfully**

**Order Details:**
• **Type**: ${orderTypeText} ${sideText} order
• **Token ID**: ${tokenId}
• **Side**: ${sideText.toUpperCase()}
• **Price**: $${price.toFixed(4)} (${(price * 100).toFixed(2)}%)
• **Size**: ${size} shares
• **Total Value**: $${totalValue}
• **Fee Rate**: ${feeRateBps} bps

**Order Response:**
• **Order ID**: ${orderResponse.orderId || 'Pending'}
• **Status**: ${orderResponse.status || 'submitted'}
${
  orderResponse.orderHashes && orderResponse.orderHashes.length > 0
    ? `• **Transaction Hash(es)**: ${orderResponse.orderHashes.join(', ')}`
    : ''
}

${
  orderResponse.status === 'matched'
    ? '🎉 Your order was immediately matched and executed!'
    : orderResponse.status === 'delayed'
      ? '⏳ Your order is subject to a matching delay due to market conditions.'
      : '📋 Your order has been placed and is waiting to be matched.'
}`;

        responseData = {
          success: true,
          orderDetails: {
            tokenId,
            side,
            price,
            size,
            orderType,
            feeRateBps,
            totalValue,
          },
          orderResponse,
          timestamp: new Date().toISOString(),
        };
      } else {
        responseText = `❌ **Order Placement Failed**

**Error**: ${orderResponse.errorMsg || 'Unknown error occurred'}

**Order Details Attempted:**
• **Token ID**: ${tokenId}
• **Side**: ${side}
• **Price**: $${price.toFixed(4)}
• **Size**: ${size} shares
• **Order Type**: ${orderType}

Please check your parameters and try again. Common issues:
• Insufficient balance or allowances
• Invalid price or size
• Market not active
• Network connectivity issues`;

        responseData = {
          success: false,
          error: orderResponse.errorMsg,
          orderDetails: {
            tokenId,
            side,
            price,
            size,
            orderType,
            feeRateBps,
          },
          timestamp: new Date().toISOString(),
        };
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_PLACE_ORDER'],
        data: responseData,
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error occurred while placing order';
      logger.error(`[placeOrderAction] Order placement error:`, error);

      const errorContent: Content = {
        text: `❌ **Order Placement Error**

**Error**: ${errorMessage}

**Order Details:**
• **Token ID**: ${tokenId}
• **Side**: ${side}
• **Price**: $${price.toFixed(4)}
• **Size**: ${size} shares

Please check your configuration and try again. Make sure:
• CLOB_API_URL is properly configured
• Token ID is valid and active
• Price and size are within acceptable ranges
• Network connection is stable`,
        actions: ['POLYMARKET_PLACE_ORDER'],
        data: {
          error: errorMessage,
          orderDetails: { tokenId, side, price, size, orderType },
        },
      };

      if (callback) {
        await callback(errorContent);
      }
      throw new Error(errorMessage);
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'I want to buy 100 shares of token 52114319501245915516055106046884209969926127482827954674443846427813813222426 at $0.50 as a limit order via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll place a limit buy order for you via Polymarket. Creating order for 100 shares at $0.50...",
          action: 'POLYMARKET_PLACE_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Place a market sell order for 50 tokens of 71321045679252212594626385532706912750332728571942532289631379312455583992563 via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll place a market sell order for you via Polymarket. This will execute immediately at the best available price...",
          action: 'POLYMARKET_PLACE_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Create a GTC order to buy 25 shares at 0.75 for market 123456789 via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll create a Good-Till-Cancelled buy order for you at $0.75 per share via Polymarket...",
          action: 'POLYMARKET_PLACE_ORDER',
        },
      },
    ],
  ],
};
