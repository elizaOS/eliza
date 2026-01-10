/**
 * @elizaos/plugin-polymarket Order Placement Actions
 *
 * Actions for placing and managing orders on Polymarket.
 */

import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from "@elizaos/core";
import { Side } from "@polymarket/clob-client";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";
import { initializeClobClient } from "../utils/clobClient";
import { orderTemplate } from "../templates";
import { OrderSide, OrderType, type OrderResponse } from "../types";

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
 */
export const placeOrderAction: Action = {
  name: "POLYMARKET_PLACE_ORDER",
  similes: [
    "PLACE_ORDER",
    "CREATE_ORDER",
    "BUY_TOKEN",
    "SELL_TOKEN",
    "LIMIT_ORDER",
    "MARKET_ORDER",
    "TRADE",
    "ORDER",
    "BUY",
    "SELL",
    "PURCHASE",
    "SUBMIT_ORDER",
    "EXECUTE_ORDER",
  ],
  description: "Create and place limit or market orders on Polymarket",

  validate: async (runtime: IAgentRuntime): Promise<boolean> => {
    const clobApiUrl = runtime.getSetting("CLOB_API_URL");
    if (!clobApiUrl) {
      logger.warn("[placeOrderAction] CLOB_API_URL is required");
      return false;
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info("[placeOrderAction] Handler called");

    let tokenId = "";
    let side = "BUY";
    let price = 0;
    let size = 0;
    let orderType = "GTC";
    let feeRateBps = "0";

    try {
      // Use LLM to extract parameters
      const llmResult = await callLLMWithTimeout<PlaceOrderParams & { error?: string }>(
        runtime,
        state,
        orderTemplate,
        "placeOrderAction"
      );

      logger.info("[placeOrderAction] LLM result:", JSON.stringify(llmResult));

      if (isLLMError(llmResult)) {
        throw new Error("Required order parameters not found");
      }

      tokenId = llmResult?.tokenId ?? "";
      side = llmResult?.side?.toUpperCase() ?? "BUY";
      price = llmResult?.price ?? 0;
      size = llmResult?.size ?? 0;
      orderType = llmResult?.orderType?.toUpperCase() ?? "GTC";
      feeRateBps = llmResult?.feeRateBps ?? "0";

      // Handle market name lookup
      if (tokenId === "MARKET_NAME_LOOKUP" && llmResult?.marketName) {
        throw new Error(
          `Market name lookup not yet implemented. Please provide a specific token ID. You requested: "${llmResult.marketName}"`
        );
      }

      if (!tokenId || price <= 0 || size <= 0) {
        throw new Error("Invalid order parameters: tokenId, price, and size are required");
      }
    } catch (error) {
      logger.warn("[placeOrderAction] LLM extraction failed, trying regex fallback");

      // Fallback to regex extraction
      const text = message.content?.text ?? "";

      const tokenMatch = text.match(/(?:token|market|id)\s+([a-zA-Z0-9]+)|([0-9]{5,})/i);
      tokenId = tokenMatch?.[1] ?? tokenMatch?.[2] ?? "";

      const sideMatch = text.match(/\b(buy|sell|long|short)\b/i);
      side = sideMatch?.[1]?.toUpperCase() ?? "BUY";

      const priceMatch = text.match(/(?:price|at|for)\s*\$?([0-9]*\.?[0-9]+)/i);
      price = priceMatch ? parseFloat(priceMatch[1]) : 0;

      const sizeMatch = text.match(
        /(?:size|amount|quantity)\s*([0-9]*\.?[0-9]+)|([0-9]*\.?[0-9]+)\s*(?:shares|tokens)/i
      );
      size = sizeMatch ? parseFloat(sizeMatch[1] ?? sizeMatch[2]) : 0;

      const orderTypeMatch = text.match(/\b(GTC|FOK|GTD|FAK|limit|market)\b/i);
      if (orderTypeMatch) {
        const matched = orderTypeMatch[1].toUpperCase();
        orderType = matched === "LIMIT" ? "GTC" : matched === "MARKET" ? "FOK" : matched;
      }

      if (!tokenId || price <= 0 || size <= 0) {
        const errorMessage = "Please provide valid order parameters: token ID, price, and size.";

        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}\n\nPlease provide order details. Examples:\n• "Buy 100 tokens of 123456 at $0.50"\n• "Sell 50 shares of token 789012 at $0.75"`,
          actions: ["POLYMARKET_PLACE_ORDER"],
          data: { error: errorMessage },
        };

        if (callback) {
          await callback(errorContent);
        }
        throw new Error(errorMessage);
      }
    }

    // Validate and normalize parameters
    if (!["BUY", "SELL"].includes(side)) {
      side = "BUY";
    }

    if (price > 1.0) {
      price = price / 100; // Convert percentage to decimal
    }

    if (!["GTC", "FOK", "GTD", "FAK"].includes(orderType)) {
      orderType = "GTC";
    }

    try {
      const client = await initializeClobClient(runtime);

      const orderArgs = {
        tokenID: tokenId,
        price,
        side: side === "BUY" ? Side.BUY : Side.SELL,
        size,
        feeRateBps: parseFloat(feeRateBps),
      };

      logger.info("[placeOrderAction] Creating order with args:", orderArgs);

      // Create the signed order
      let signedOrder;
      try {
        signedOrder = await client.createOrder(orderArgs);
        logger.info("[placeOrderAction] Order created successfully");
      } catch (createError) {
        logger.error("[placeOrderAction] Error creating order:", createError);

        if (createError instanceof Error) {
          if (createError.message.includes("minimum_tick_size")) {
            throw new Error(
              "Invalid market data: The market may not exist or be inactive."
            );
          }
          if (createError.message.includes("undefined is not an object")) {
            throw new Error(
              "Market data unavailable: The token ID may be invalid or the market may be closed."
            );
          }
        }
        throw createError;
      }

      // Post the order
      let orderResponse: OrderResponse;
      try {
        orderResponse = await client.postOrder(signedOrder, orderType as OrderType);
        logger.info("[placeOrderAction] Order posted successfully");
      } catch (postError) {
        logger.error("[placeOrderAction] Error posting order:", postError);
        throw new Error(
          `Failed to submit order: ${postError instanceof Error ? postError.message : "Unknown error"}`
        );
      }

      // Format response
      let responseText: string;
      let responseData: Record<string, unknown>;

      if (orderResponse.success) {
        const sideText = side.toLowerCase();
        const orderTypeText =
          orderType === "GTC" ? "limit" : orderType === "FOK" ? "market" : orderType.toLowerCase();
        const totalValue = (price * size).toFixed(4);

        responseText = `✅ **Order Placed Successfully**\n\n` +
          `**Order Details:**\n` +
          `• Type: ${orderTypeText} ${sideText} order\n` +
          `• Token ID: \`${tokenId}\`\n` +
          `• Side: ${side}\n` +
          `• Price: $${price.toFixed(4)} (${(price * 100).toFixed(2)}%)\n` +
          `• Size: ${size} shares\n` +
          `• Total Value: $${totalValue}\n\n` +
          `**Order Response:**\n` +
          `• Order ID: ${orderResponse.orderId ?? "Pending"}\n` +
          `• Status: ${orderResponse.status ?? "submitted"}`;

        if (orderResponse.orderHashes?.length) {
          responseText += `\n• Transaction Hash(es): ${orderResponse.orderHashes.join(", ")}`;
        }

        if (orderResponse.status === "matched") {
          responseText += "\n\n🎉 Your order was immediately matched!";
        } else if (orderResponse.status === "delayed") {
          responseText += "\n\n⏳ Your order is subject to a matching delay.";
        }

        responseData = {
          success: true,
          orderDetails: { tokenId, side, price, size, orderType, feeRateBps, totalValue },
          orderResponse,
          timestamp: new Date().toISOString(),
        };
      } else {
        responseText = `❌ **Order Placement Failed**\n\n` +
          `**Error**: ${orderResponse.errorMsg ?? "Unknown error"}\n\n` +
          `**Order Details Attempted:**\n` +
          `• Token ID: ${tokenId}\n` +
          `• Side: ${side}\n` +
          `• Price: $${price.toFixed(4)}\n` +
          `• Size: ${size} shares`;

        responseData = {
          success: false,
          error: orderResponse.errorMsg,
          orderDetails: { tokenId, side, price, size, orderType },
          timestamp: new Date().toISOString(),
        };
      }

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_PLACE_ORDER"],
        data: responseData,
      };

      if (callback) {
        await callback(responseContent);
      }

      return responseContent;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error occurred";
      logger.error("[placeOrderAction] Order placement error:", error);

      const errorContent: Content = {
        text: `❌ **Order Placement Error**\n\n` +
          `**Error**: ${errorMessage}\n\n` +
          `**Order Details:**\n` +
          `• Token ID: ${tokenId}\n` +
          `• Side: ${side}\n` +
          `• Price: $${price.toFixed(4)}\n` +
          `• Size: ${size} shares`,
        actions: ["POLYMARKET_PLACE_ORDER"],
        data: {
          error: errorMessage,
          orderDetails: { tokenId, side, price, size, orderType },
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
        name: "{{user1}}",
        content: {
          text: "Buy 100 shares of token 123456 at $0.50 as a limit order",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll place a limit buy order for you on Polymarket.",
          action: "POLYMARKET_PLACE_ORDER",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Place a market sell order for 50 tokens of 789012",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll place a market sell order for you.",
          action: "POLYMARKET_PLACE_ORDER",
        },
      },
    ],
  ],
};
