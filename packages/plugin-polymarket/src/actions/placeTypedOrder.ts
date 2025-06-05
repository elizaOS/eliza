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
import { ethers } from 'ethers';
import { checkAndApproveUSDC } from '../utils/usdcApproval';

// Define the payload for the placeTypedOrder action
export interface PlaceTypedOrderPayload {
  tokenId: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  orderType: 'GTC' | 'FOK' | 'GTD';
  expiration?: number; // Unix timestamp for GTD orders
  feeRateBps?: string;
  error?: string; // For error handling in parameter extraction
}

// Define the response structure for the callback data property
export interface PlaceTypedOrderResponseData {
  success: boolean;
  orderDetails: {
    tokenId: string;
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
    orderType: string;
    expiration?: number;
    feeRateBps: string;
    totalValue: string;
  };
  orderResponse: {
    success: boolean;
    orderId?: string;
    status?: 'matched' | 'delayed' | 'unmatched';
    orderHashes?: string[];
    errorMsg?: string;
  };
  timestamp: string;
}

/**
 * Place Typed Order Action for Polymarket CLOB
 * Creates and places orders with specific types: GTC, FOK, GTD
 */
export const placeTypedOrderAction: Action = {
  name: 'PLACE_TYPED_ORDER',
  similes: [
    'PLACE_TYPED_ORDER',
    'CREATE_TYPED_ORDER',
    'PLACE_GTC_ORDER',
    'PLACE_FOK_ORDER',
    'PLACE_GTD_ORDER',
    'CREATE_GTC_ORDER',
    'CREATE_FOK_ORDER',
    'CREATE_GTD_ORDER',
    'TYPED_ORDER',
    'SPECIFIC_ORDER_TYPE',
    'ORDER_WITH_TYPE',
    'LIMIT_ORDER_TYPED',
    'MARKET_ORDER_TYPED',
    'TIMED_ORDER',
    'EXPIRING_ORDER',
  ],
  description:
    'Create and place typed orders (GTC, FOK, GTD) on Polymarket prediction markets with explicit order type handling and expiration support.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info('[placeTypedOrderAction] Validating action');

    // Check if CLOB API URL is configured
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');
    if (!clobApiUrl) {
      logger.error('[placeTypedOrderAction] CLOB_API_URL is required in configuration');
      return false;
    }

    // Check if we have API credentials
    const apiKey = runtime.getSetting('CLOB_API_KEY');
    const apiSecret = runtime.getSetting('CLOB_API_SECRET') || runtime.getSetting('CLOB_SECRET');
    const apiPassphrase =
      runtime.getSetting('CLOB_API_PASSPHRASE') || runtime.getSetting('CLOB_PASS_PHRASE');

    if (!apiKey || !apiSecret || !apiPassphrase) {
      logger.error(
        '[placeTypedOrderAction] Missing required API credentials (CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE) in environment.'
      );
      return false;
    }

    // Check if we have private key for order signing
    const privateKey =
      runtime.getSetting('POLYMARKET_PRIVATE_KEY') ||
      runtime.getSetting('WALLET_PRIVATE_KEY') ||
      runtime.getSetting('PRIVATE_KEY');

    if (!privateKey) {
      logger.error(
        '[placeTypedOrderAction] Missing required private key (POLYMARKET_PRIVATE_KEY, WALLET_PRIVATE_KEY, or PRIVATE_KEY) in environment.'
      );
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[placeTypedOrderAction] Handler called!');

    try {
      // Extract order parameters from user message using LLM
      const extractionPrompt = `
Extract the typed order parameters from this message about placing a specific order type:
"${message.content.text}"

Extract and return a JSON object with the following fields:
- tokenId: string (the token/asset ID to trade)
- side: "BUY" or "SELL" 
- price: number (price per share, between 0.0 and 1.0 for prediction markets)
- size: number (number of shares)
- orderType: "GTC" or "FOK" or "GTD" (order type)
- expiration: number (optional, Unix timestamp for GTD orders only)
- feeRateBps: string (optional, fee rate in basis points, default "0")

Order Type Guidelines:
- GTC (Good Till Cancelled): Limit order that stays active until filled or cancelled
- FOK (Fill Or Kill): Market order that must execute immediately in full or be cancelled
- GTD (Good Till Date): Order with expiration date/time

Examples:
- "Place GTC buy order for 100 shares of token 123456 at $0.50" → {"tokenId": "123456", "side": "BUY", "price": 0.50, "size": 100, "orderType": "GTC", "feeRateBps": "0"}
- "Create FOK sell order for 50 tokens 789012 at price 0.75" → {"tokenId": "789012", "side": "SELL", "price": 0.75, "size": 50, "orderType": "FOK", "feeRateBps": "0"}
- "Place GTD order to buy 25 shares of 456789 at $0.60 expiring in 1 hour" → {"tokenId": "456789", "side": "BUY", "price": 0.60, "size": 25, "orderType": "GTD", "expiration": [current_time + 3600], "feeRateBps": "0"}

If any required field is missing or "NONE", return {"error": "Missing required parameters"}.
Return only the JSON object, no additional text.
`;

      logger.info('[placeTypedOrderAction] Starting LLM parameter extraction...');

      const extractedParams = await callLLMWithTimeout(
        runtime,
        state,
        extractionPrompt,
        'placeTypedOrderAction',
        10000
      );

      logger.debug(`[placeTypedOrderAction] Parsed LLM parameters:`, extractedParams);

      // Handle both string and object responses from LLM
      let orderParams: PlaceTypedOrderPayload;
      if (typeof extractedParams === 'string') {
        try {
          orderParams = JSON.parse(extractedParams);
        } catch (parseError) {
          throw new Error(`Failed to parse LLM response as JSON: ${extractedParams}`);
        }
      } else if (typeof extractedParams === 'object' && extractedParams !== null) {
        orderParams = extractedParams as PlaceTypedOrderPayload;
      } else {
        throw new Error('Invalid response from LLM parameter extraction');
      }

      // Validate extracted parameters
      if (
        !orderParams ||
        orderParams.error ||
        !orderParams.tokenId ||
        !orderParams.side ||
        orderParams.price === undefined ||
        orderParams.size === undefined ||
        !orderParams.orderType
      ) {
        // Try regex fallback for structured input
        const regexPattern =
          /(?:place|create)\s+(\w+)\s+(?:order\s+)?(?:for\s+)?(\d+)\s+(?:shares?\s+of\s+)?(?:token\s+)?(\d+)\s+at\s+(?:\$)?([0-9.]+)(?:\s+(?:expiring|expires)\s+(.+))?/i;
        const regexMatch = message.content.text.match(regexPattern);

        if (regexMatch) {
          const [, orderType, size, tokenId, price, expirationText] = regexMatch;

          // Determine side from context
          const side = message.content.text.toLowerCase().includes('sell') ? 'SELL' : 'BUY';

          orderParams = {
            tokenId: tokenId,
            side: side as 'BUY' | 'SELL',
            price: parseFloat(price),
            size: parseInt(size),
            orderType: orderType.toUpperCase() as 'GTC' | 'FOK' | 'GTD',
            feeRateBps: '0',
          };

          // Handle expiration for GTD orders
          if (orderParams.orderType === 'GTD' && expirationText) {
            const currentTime = Math.floor(Date.now() / 1000);
            if (expirationText.includes('hour')) {
              const hours = parseInt(expirationText.match(/(\d+)/)?.[1] || '1');
              orderParams.expiration = currentTime + hours * 3600;
            } else if (expirationText.includes('minute')) {
              const minutes = parseInt(expirationText.match(/(\d+)/)?.[1] || '30');
              orderParams.expiration = currentTime + minutes * 60;
            } else {
              orderParams.expiration = currentTime + 3600; // Default 1 hour
            }
          }
        } else {
          const errorMessage = `❌ **Order Placement Failed**

**Error**: Please provide valid typed order parameters

**Required Parameters**:
• **Token ID**: The market token identifier
• **Side**: BUY or SELL
• **Price**: Price per share (0.0-1.0)
• **Size**: Number of shares
• **Order Type**: GTC, FOK, or GTD

**Order Types**:
• **GTC** (Good Till Cancelled): Limit order active until filled or cancelled
• **FOK** (Fill Or Kill): Market order that executes immediately or fails
• **GTD** (Good Till Date): Order with expiration date

**Examples**:
• "Place GTC buy order for 100 shares of token 123456 at $0.50"
• "Create FOK sell order for 50 tokens 789012 at price 0.75"
• "Place GTD order to buy 25 shares of 456789 at $0.60 expiring in 2 hours"`;

          const errorContent: Content = {
            text: errorMessage,
            actions: ['PLACE_TYPED_ORDER'],
            data: {
              success: false,
              orderDetails: {},
              orderResponse: { success: false, errorMsg: 'Missing required parameters' },
              timestamp: new Date().toISOString(),
            } as PlaceTypedOrderResponseData,
          };

          if (callback) {
            await callback(errorContent);
          }
          return errorContent;
        }
      }

      // Validate order type
      if (!['GTC', 'FOK', 'GTD'].includes(orderParams.orderType)) {
        throw new Error(`Invalid order type: ${orderParams.orderType}. Must be GTC, FOK, or GTD`);
      }

      // Validate GTD expiration
      if (orderParams.orderType === 'GTD' && !orderParams.expiration) {
        const currentTime = Math.floor(Date.now() / 1000);
        orderParams.expiration = currentTime + 3600; // Default 1 hour expiration
        logger.info(
          `[placeTypedOrderAction] GTD order without expiration, defaulting to 1 hour: ${orderParams.expiration}`
        );
      }

      // Validate price range for prediction markets
      if (orderParams.price < 0.01 || orderParams.price > 0.99) {
        throw new Error(
          `Price ${orderParams.price} is outside valid range (0.01-0.99) for prediction markets`
        );
      }

      // Validate size
      if (orderParams.size <= 0) {
        throw new Error(`Size ${orderParams.size} must be greater than 0`);
      }

      logger.info(`[placeTypedOrderAction] Validated order parameters:`, {
        tokenId: orderParams.tokenId,
        side: orderParams.side,
        price: orderParams.price,
        size: orderParams.size,
        orderType: orderParams.orderType,
        expiration: orderParams.expiration,
      });

      // Initialize CLOB client with credentials
      const client = await initializeClobClientWithCreds(runtime);

      // NEW: Check and handle USDC approval BEFORE placing order
      logger.info(`[placeTypedOrderAction] Checking USDC approval for order...`);

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
      const orderValue = orderParams.price * orderParams.size;

      // Only check approval for BUY orders (selling doesn't require USDC)
      let approvalResult = null;
      if (orderParams.side === 'BUY') {
        logger.info(
          `[placeTypedOrderAction] BUY order detected, checking USDC approval for $${orderValue}`
        );

        // Check and approve USDC if needed (approve unlimited for better UX)
        approvalResult = await checkAndApproveUSDC(wallet, provider, orderValue, true);

        if (!approvalResult.success) {
          // Return early with approval error
          const approvalError = `❌ **USDC Approval Required**

${approvalResult.error}

**Order Details:**
• **Token ID**: ${orderParams.tokenId}
• **Side**: ${orderParams.side} (requires USDC)
• **Type**: ${orderParams.orderType}
• **Price**: $${orderParams.price.toFixed(4)}
• **Size**: ${orderParams.size} shares
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
            actions: ['PLACE_TYPED_ORDER'],
            data: {
              success: false,
              orderDetails: {},
              orderResponse: { success: false, errorMsg: approvalResult.error },
              timestamp: new Date().toISOString(),
            } as PlaceTypedOrderResponseData,
          };

          if (callback) {
            await callback(errorContent);
          }
          return errorContent;
        }

        logger.info(`[placeTypedOrderAction] USDC approval successful:`, approvalResult);
      } else {
        logger.info(`[placeTypedOrderAction] SELL order detected, no USDC approval needed`);
      }

      // Build order arguments (fix feeRateBps type)
      const orderArgs = {
        tokenID: orderParams.tokenId,
        price: orderParams.price,
        size: orderParams.size,
        side: orderParams.side as any,
        feeRateBps: parseFloat(orderParams.feeRateBps || '0'), // Convert to number
        nonce: 0,
      };

      // Add expiration for GTD orders
      if (orderParams.orderType === 'GTD' && orderParams.expiration) {
        (orderArgs as any).expiration = orderParams.expiration;
      }

      logger.info('[placeTypedOrderAction] Creating order...');

      // Create the order using CLOB client
      const signedOrder = await client.createOrder(orderArgs);

      logger.info('[placeTypedOrderAction] Order created, submitting to CLOB...');

      // Post the order with the specified type using string directly
      const orderResponse = await client.postOrder(signedOrder, orderParams.orderType as any);

      logger.info('[placeTypedOrderAction] Order submitted successfully:', orderResponse);

      // Calculate total value
      const totalValue = (orderParams.price * orderParams.size).toFixed(4);

      // Format the response
      const responseData: PlaceTypedOrderResponseData = {
        success: true,
        orderDetails: {
          tokenId: orderParams.tokenId,
          side: orderParams.side,
          price: orderParams.price,
          size: orderParams.size,
          orderType: orderParams.orderType,
          expiration: orderParams.expiration,
          feeRateBps: orderParams.feeRateBps || '0',
          totalValue,
        },
        orderResponse: {
          success: orderResponse.success || false,
          orderId: orderResponse.orderId || undefined,
          status: orderResponse.status || undefined,
          orderHashes: orderResponse.orderHashes || undefined,
          errorMsg: orderResponse.errorMsg || undefined,
        },
        timestamp: new Date().toISOString(),
      };

      // Create success message
      let statusMessage = '';
      if (orderResponse.success) {
        if (orderResponse.status === 'matched') {
          statusMessage = '🎉 Your order was immediately matched and executed!';
        } else if (orderResponse.status === 'delayed') {
          statusMessage = '⏳ Your order is subject to matching delay due to market conditions.';
        } else {
          statusMessage = '📋 Your order has been placed and is waiting to be matched.';
        }
      }

      const orderTypeDescriptions = {
        GTC: 'Good Till Cancelled (limit order)',
        FOK: 'Fill Or Kill (market order)',
        GTD: 'Good Till Date (expiring order)',
      };

      let expirationInfo = '';
      if (orderParams.orderType === 'GTD' && orderParams.expiration) {
        const expirationDate = new Date(orderParams.expiration * 1000);
        expirationInfo = `\n• **Expiration**: ${expirationDate.toLocaleString()}`;
      }

      // Add approval information for BUY orders
      let approvalInfo = '';
      if (orderParams.side === 'BUY' && approvalResult) {
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

      const successMessage = `✅ **${orderParams.orderType} Order Placed Successfully**
${approvalInfo}
**Order Details:**
• **Type**: ${orderTypeDescriptions[orderParams.orderType]} ${orderParams.side.toLowerCase()}
• **Token ID**: ${orderParams.tokenId}
• **Side**: ${orderParams.side}
• **Price**: $${orderParams.price.toFixed(4)} (${(orderParams.price * 100).toFixed(2)}%)
• **Size**: ${orderParams.size} shares
• **Total Value**: $${totalValue}
• **Fee Rate**: ${orderParams.feeRateBps} bps${expirationInfo}

**Order Response:**
• **Order ID**: ${orderResponse.orderId || 'N/A'}
• **Status**: ${orderResponse.status || 'unknown'}
${orderResponse.orderHashes ? `• **Transaction Hash(es)**: ${orderResponse.orderHashes.join(', ')}` : ''}

${statusMessage}`;

      const successContent: Content = {
        text: successMessage,
        actions: ['PLACE_TYPED_ORDER'],
        data: {
          ...responseData,
          approvalResult,
        },
      };

      if (callback) {
        await callback(successContent);
      }
      return successContent;
    } catch (error: any) {
      logger.error('[placeTypedOrderAction] Error placing typed order:', error);

      let errorMessage = 'An unexpected error occurred while placing the typed order.';
      if (error.message) {
        if (error.message.includes('insufficient')) {
          errorMessage =
            'Insufficient balance to place this order. Please check your account balance.';
        } else if (error.message.includes('market')) {
          errorMessage = 'Invalid market data. The market may not exist or be inactive.';
        } else if (error.message.includes('price')) {
          errorMessage =
            'Invalid price. Price must be between 0.01 and 0.99 for prediction markets.';
        } else if (error.message.includes('size')) {
          errorMessage = 'Invalid order size. Size must be greater than 0.';
        } else if (error.message.includes('expiration')) {
          errorMessage = 'Invalid expiration time for GTD order.';
        } else {
          errorMessage = error.message;
        }
      }

      const errorContent: Content = {
        text: `❌ **Typed Order Placement Failed**

**Error**: ${errorMessage}

**Possible Causes:**
• Insufficient account balance or allowances
• Invalid order parameters (price, size, token ID)
• Market is inactive or does not exist
• Network connectivity issues
• Invalid order type or expiration (for GTD)
• Rate limiting from Polymarket API

**Order Types:**
• **GTC**: Good Till Cancelled - limit order active until filled or cancelled
• **FOK**: Fill Or Kill - market order that executes immediately or fails
• **GTD**: Good Till Date - order with expiration timestamp

**Please check your parameters and try again.**`,
        actions: ['PLACE_TYPED_ORDER'],
        data: {
          success: false,
          orderDetails: {},
          orderResponse: { success: false, errorMsg: errorMessage },
          timestamp: new Date().toISOString(),
        } as PlaceTypedOrderResponseData,
      };

      if (callback) {
        await callback(errorContent);
      }
      return errorContent;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Place GTC buy order for 100 shares of token 123456 at $0.50',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll create a Good Till Cancelled (GTC) limit order to buy 100 shares at $0.50. This order will remain active until filled or cancelled.",
          action: 'PLACE_TYPED_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Create FOK sell order for 50 tokens 789012 at price 0.75',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll create a Fill Or Kill (FOK) market order to sell 50 shares at $0.75. This order will execute immediately or be cancelled entirely.",
          action: 'PLACE_TYPED_ORDER',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Place GTD order to buy 25 shares of 456789 at $0.60 expiring in 2 hours',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll create a Good Till Date (GTD) order to buy 25 shares at $0.60 with a 2-hour expiration. The order will automatically cancel if not filled by then.",
          action: 'PLACE_TYPED_ORDER',
        },
      },
    ],
  ],
};
