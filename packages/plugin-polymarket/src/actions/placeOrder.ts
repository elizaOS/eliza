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
import { initializeClobClientWithCreds } from '../utils/clobClient';
import { orderTemplate } from '../templates';
import { OrderSide, OrderType } from '../types';
import { ClobClient, Side } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { checkAndApproveUSDC, formatApprovalResult } from '../utils/usdcApproval';

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

    // Check if this is actually a cancel order request
    const messageText = message.content?.text?.toLowerCase() || '';
    const cancelKeywords = [
      'cancel',
      'stop',
      'remove',
      'delete',
      'abort',
      'revoke',
      'withdraw',
      'kill',
      'terminate',
      'close',
    ];
    const containsCancelKeyword = cancelKeywords.some((keyword) => messageText.includes(keyword));

    if (containsCancelKeyword) {
      logger.info('[placeOrderAction] Message contains cancel keywords, rejecting validation');
      return false;
    }

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

Please provide order details in your request. Here are comprehensive examples:

**📈 BUY ORDERS:**
• "Buy 100 tokens of 123456 at $0.50 limit order"
• "Place buy order for 50 shares of token 789012 at $0.65"
• "Create limit buy for 25 tokens of market 456789 at price $0.40"
• "BUY 200 shares at $0.75 for token ID 321654"
• "Purchase 75 tokens of 987654 at $0.35 with GTC order"
• "Long 150 shares of 111222 at $0.80"

**📉 SELL ORDERS:**
• "Sell 50 shares of token 789012 at $0.75"
• "Place sell order for 100 tokens of 456789 at $0.60"
• "Create limit sell for 25 shares of market 321654 at price $0.85"
• "SELL 75 tokens at $0.45 for token ID 987654"
• "Short 200 shares of 555666 at $0.30"
• "Liquidate 125 tokens of 777888 at $0.70"

**🚀 MARKET ORDERS (Immediate execution):**
• "Place market order to buy 25 tokens of 456789"
• "Market buy 100 shares of token 123456"
• "Execute immediate sell of 50 tokens for 789012"
• "FOK buy order for 75 shares of 321654"
• "Quick sell 200 tokens of 987654 at market price"

**⏰ TIME-BASED ORDERS:**
• "Buy 100 tokens of 123456 at $0.50 GTD order (Good Till Day)"
• "Sell 50 shares of 789012 at $0.75 FAK order (Fill And Kill)"
• "Place GTC buy for 25 tokens of 456789 at $0.40 (Good Till Cancelled)"

**💰 ADVANCED PRICING:**
• "Buy 100 tokens of 123456 at $0.505 with fee rate 50 basis points"
• "Sell 75 shares of 789012 at $0.6789 precision pricing"
• "Place order: token 456789, buy side, 50 size, $0.4321 price"

**🎯 PREDICTION MARKET EXAMPLES:**
• "Buy 100 YES tokens for 'Will Bitcoin hit $100k?' at $0.65"
• "Sell 50 NO shares for election market 789012 at $0.40" 
• "Long 200 tokens on sports outcome 456789 at $0.75"
• "Short 75 shares on weather prediction 321654 at $0.25"

**📊 COMPLEX SCENARIOS:**
• "Create buy order: 150 tokens, market ID 123456, limit price $0.55, GTC type"
• "Place sell order with parameters: tokenId=789012, side=SELL, price=0.80, size=100, orderType=FOK"
• "Submit trade: BUY 75 @ $0.45 for token 456789 with 100 bps fee"

**Required parameters:**
- **Token ID**: Market identifier (6+ digit number or hex)
- **Side**: BUY/SELL (or LONG/SHORT)
- **Price**: USD amount (0.01-1.00 for prediction markets)
- **Size**: Number of shares/tokens

**Optional parameters:**
- **Order Type**: GTC (limit), FOK (market), GTD, FAK
- **Fee Rate**: Basis points (0-1000)

**💡 Pro Tips:**
• Use specific token IDs for best results
• Prediction market prices are typically 0.01-1.00
• GTC orders stay open until filled or cancelled
• FOK orders execute immediately or fail
• Market orders use FOK type automatically`,
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
      const client = await initializeClobClientWithCreds(runtime);

      // NEW: Check and handle USDC approval BEFORE placing order
      logger.info(`[placeOrderAction] Checking USDC approval for order...`);

      // Get wallet private key and create wallet instance
      const privateKey =
        runtime.getSetting('WALLET_PRIVATE_KEY') ||
        runtime.getSetting('PRIVATE_KEY') ||
        runtime.getSetting('POLYMARKET_PRIVATE_KEY');

      if (!privateKey) {
        throw new Error('No private key found for USDC approval');
      }

      // Create wallet and provider for Polygon
      const wallet = new ethers.Wallet(privateKey);
      const polygonRpcUrl =
        runtime.getSetting('POLYGON_RPC_URL') || 'https://polygon-bor-rpc.publicnode.com';
      const provider = new ethers.JsonRpcProvider(polygonRpcUrl);

      // Calculate order value (only for BUY orders need USDC)
      const rawOrderValue = price * size;
      const orderValue = Math.round(rawOrderValue * 1000000) / 1000000; // Round to 6 decimal places

      logger.info(
        `[placeOrderAction] Order value calculation: ${price} * ${size} = ${rawOrderValue} -> ${orderValue} (rounded)`
      );

      // Only check approval for BUY orders (selling doesn't require USDC)
      let approvalResult = null;
      if (side === 'BUY') {
        logger.info(
          `[placeOrderAction] BUY order detected, checking USDC approval for $${orderValue}`
        );

        // Check and approve USDC if needed (approve unlimited for better UX)
        approvalResult = await checkAndApproveUSDC(wallet, provider, orderValue, true);

        if (!approvalResult.success) {
          // Return early with approval error
          const approvalError = `❌ **USDC Approval Required**

${approvalResult.error}

**Order Details:**
• **Token ID**: ${tokenId}
• **Side**: ${side} (requires USDC)
• **Price**: $${price.toFixed(4)}
• **Size**: ${size} shares
• **Total Value**: $${orderValue.toFixed(4)} USDC

**To complete this order:**
1. Ensure you have sufficient USDC on Polygon network
2. Bridge USDC from Ethereum if needed: https://portal.polygon.technology/
3. Try placing the order again

**Current Status:**
• **USDC Balance**: ${approvalResult.balance} USDC
• **Required**: ${approvalResult.requiredAmount} USDC`;

          const errorContent: Content = {
            text: approvalError,
            actions: ['PLACE_ORDER'],
            data: {
              success: false,
              error: approvalResult.error,
              approvalResult,
              orderDetails: { tokenId, side, price, size, orderType },
            },
          };

          if (callback) {
            await callback(errorContent);
          }
          throw new Error(approvalResult.error);
        }

        logger.info(`[placeOrderAction] USDC approval successful:`, approvalResult);
      } else {
        logger.info(`[placeOrderAction] SELL order detected, no USDC approval needed`);
      }

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
        logger.info(`[placeOrderAction] Order response:`, JSON.stringify(orderResponse, null, 2));
      } catch (postError) {
        logger.error(`[placeOrderAction] Error posting order:`, postError);
        throw new Error(
          `Failed to submit order: ${postError instanceof Error ? postError.message : 'Unknown error'}`
        );
      }

      // Format response based on success
      let responseText: string;
      let responseData: any;

      // Enhanced response parsing to handle different response structures
      let isSuccess = false;
      let orderId: string | undefined;
      let errorMessage: string | undefined;
      let status: string | undefined;
      let orderHashes: string[] | undefined;

      // Check various ways the response might indicate success
      if (orderResponse) {
        // Method 1: Direct success property
        if (typeof orderResponse.success === 'boolean') {
          isSuccess = orderResponse.success;
        }
        // Method 2: Check if we have an orderId (usually indicates success)
        else if (orderResponse.orderId || orderResponse.order_id) {
          isSuccess = true;
        }
        // Method 3: Check if status indicates success
        else if (
          orderResponse.status &&
          ['matched', 'unmatched', 'delayed'].includes(orderResponse.status)
        ) {
          isSuccess = true;
        }
        // Method 4: If no explicit error message and we have some response, assume success
        else if (
          !orderResponse.errorMsg &&
          !orderResponse.error &&
          typeof orderResponse === 'object'
        ) {
          isSuccess = true;
        }

        // Extract response details
        orderId = orderResponse.orderId || orderResponse.order_id;
        errorMessage = orderResponse.errorMsg || orderResponse.error || orderResponse.message;
        status = orderResponse.status;
        orderHashes = orderResponse.orderHashes || orderResponse.order_hashes;

        logger.info(
          `[placeOrderAction] Parsed response - isSuccess: ${isSuccess}, orderId: ${orderId}, error: ${errorMessage}`
        );
      } else {
        // No response object means something went wrong
        isSuccess = false;
        errorMessage = 'No response received from order posting';
      }

      if (isSuccess) {
        const sideText = side.toLowerCase();
        const orderTypeText =
          orderType === 'GTC' ? 'limit' : orderType === 'FOK' ? 'market' : orderType.toLowerCase();
        const totalValue = (price * size).toFixed(4);

        // Add approval information for BUY orders
        let approvalInfo = '';
        if (side === 'BUY' && approvalResult) {
          if (approvalResult.approvalNeeded) {
            approvalInfo = `\n**USDC Approval:**
• **Status**: ✅ Automatically approved
• **Transaction**: ${approvalResult.approvalTxHash}
• **Gas Cost**: ${approvalResult.gasCost} MATIC
• **Allowance**: Unlimited (optimal for trading)

`;
          } else {
            approvalInfo = `\n**USDC Status:**
• **Balance**: ${approvalResult.balance} USDC ✅
• **Allowance**: Sufficient for trading ✅

`;
          }
        }

        responseText = `✅ **Order Placed Successfully**
${approvalInfo}
**Order Details:**
• **Type**: ${orderTypeText} ${sideText} order
• **Token ID**: ${tokenId}
• **Side**: ${sideText.toUpperCase()}
• **Price**: $${price.toFixed(4)} (${(price * 100).toFixed(2)}%)
• **Size**: ${size} shares
• **Total Value**: $${totalValue}
• **Fee Rate**: ${feeRateBps} bps

**Order Response:**
• **Order ID**: ${orderId || 'Pending'}
• **Status**: ${status || 'submitted'}
${
  orderHashes && orderHashes.length > 0
    ? `• **Transaction Hash(es)**: ${orderHashes.join(', ')}`
    : ''
}

${
  status === 'matched'
    ? '🎉 Your order was immediately matched and executed!'
    : status === 'delayed'
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
          orderResponse: {
            orderId,
            status,
            orderHashes,
            originalResponse: orderResponse,
          },
          approvalResult,
          timestamp: new Date().toISOString(),
        };
      } else {
        responseText = `❌ **Order Placement Failed**

**Error**: ${errorMessage || 'Unknown error occurred'}

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
• Network connectivity issues

**Debug Info**: Response received but no success indicator found. This might indicate a response format issue or an edge case.`;

        responseData = {
          success: false,
          error: errorMessage || 'Unknown error occurred',
          orderDetails: {
            tokenId,
            side,
            price,
            size,
            orderType,
            feeRateBps,
          },
          debugInfo: {
            originalResponse: orderResponse,
            responseType: typeof orderResponse,
            responseKeys: orderResponse ? Object.keys(orderResponse) : [],
          },
          timestamp: new Date().toISOString(),
        };
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['PLACE_ORDER'],
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
        actions: ['PLACE_ORDER'],
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
          text: 'I want to buy 100 shares of token 52114319501245915516055106046884209969926127482827954674443846427813813222426 at $0.50 as a limit order',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll place a limit buy order for you. Creating order for 100 shares at $0.50...",
          action: 'PLACE_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Place a market sell order for 50 tokens of 71321045679252212594626385532706912750332728571942532289631379312455583992563',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll place a market sell order for you. This will execute immediately at the best available price...",
          action: 'PLACE_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Create a GTC order to buy 25 shares at 0.75 for market 123456789',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll create a Good-Till-Cancelled buy order for you at $0.75 per share...",
          action: 'PLACE_ORDER',
        },
      },
    ],
  ],
};
