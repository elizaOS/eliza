/**
 * @elizaos/plugin-polymarket Order Placement Actions
 *
 * Actions for placing and managing orders on Polymarket.
 */

import {
  type Action,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import {
  type ClobClient,
  OrderType as ClobOrderType,
  Side,
  type UserOrder,
} from "@polymarket/clob-client";
import { orderTemplate } from "../templates";
import type { OrderResponse } from "../types";
import { initializeClobClient } from "../utils/clobClient";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

interface PlaceOrderParams {
  tokenId: string;
  side: string;
  price: number;
  size: number;
  orderType?: string;
  feeRateBps?: string;
  marketName?: string;
  error?: string;
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
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    logger.info("[placeOrderAction] Handler called");

    // Use LLM to extract parameters
    const llmResult = await callLLMWithTimeout<PlaceOrderParams>(
      runtime,
      state,
      orderTemplate,
      "placeOrderAction"
    );

    logger.info("[placeOrderAction] LLM result:", JSON.stringify(llmResult));

    if (isLLMError(llmResult)) {
      throw new Error("Required order parameters not found");
    }

    const tokenId = llmResult?.tokenId ?? "";
    let side = llmResult?.side?.toUpperCase() ?? "BUY";
    let price = llmResult?.price ?? 0;
    const size = llmResult?.size ?? 0;
    let orderType = llmResult?.orderType?.toUpperCase() ?? "GTC";
    const feeRateBps = llmResult?.feeRateBps ?? "0";

    // Handle market name lookup
    if (tokenId === "MARKET_NAME_LOOKUP" && llmResult?.marketName) {
      throw new Error(
        `Market name lookup not yet implemented. Please provide a specific token ID. You requested: "${llmResult.marketName}"`
      );
    }

    if (!tokenId || price <= 0 || size <= 0) {
      throw new Error("Invalid order parameters: tokenId, price, and size are required");
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

    const client = (await initializeClobClient(runtime)) as ClobClient;

    const orderArgs: UserOrder = {
      tokenID: tokenId,
      price,
      side: side === "BUY" ? Side.BUY : Side.SELL,
      size,
      feeRateBps: parseFloat(feeRateBps),
    };

    logger.info(
      "[placeOrderAction] Creating and posting order with args:",
      JSON.stringify(orderArgs)
    );

    // Create and post the order - use appropriate method based on order type
    // createAndPostOrder is for limit orders (GTC, GTD)
    // createAndPostMarketOrder is for market orders (FOK, FAK)
    let orderResponse: OrderResponse;

    if (orderType === "FOK" || orderType === "FAK") {
      // Market orders use createAndPostMarketOrder with UserMarketOrder format
      const marketOrderType = orderType === "FAK" ? ClobOrderType.FAK : ClobOrderType.FOK;
      const marketOrderArgs = {
        tokenID: tokenId,
        price,
        amount: size, // Market orders use 'amount' instead of 'size'
        side: side === "BUY" ? Side.BUY : Side.SELL,
        feeRateBps: parseFloat(feeRateBps),
        orderType: marketOrderType as ClobOrderType.FOK | ClobOrderType.FAK,
      };
      orderResponse = (await client.createAndPostMarketOrder(marketOrderArgs)) as OrderResponse;
    } else {
      // Limit orders (GTC, GTD)
      const clobOrderType = orderType === "GTD" ? ClobOrderType.GTD : ClobOrderType.GTC;
      orderResponse = (await client.createAndPostOrder(
        orderArgs,
        undefined,
        clobOrderType
      )) as OrderResponse;
    }
    logger.info("[placeOrderAction] Order posted successfully");

    // Format response
    let responseText: string;

    if (orderResponse.success) {
      const sideText = side.toLowerCase();
      const orderTypeText =
        orderType === "GTC" ? "limit" : orderType === "FOK" ? "market" : orderType.toLowerCase();
      const totalValue = (price * size).toFixed(4);

      responseText =
        `✅ **Order Placed Successfully**\n\n` +
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
    } else {
      responseText =
        `❌ **Order Placement Failed**\n\n` +
        `**Error**: ${orderResponse.errorMsg ?? "Unknown error"}\n\n` +
        `**Order Details Attempted:**\n` +
        `• Token ID: ${tokenId}\n` +
        `• Side: ${side}\n` +
        `• Price: $${price.toFixed(4)}\n` +
        `• Size: ${size} shares`;
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["POLYMARKET_PLACE_ORDER"],
    };

    if (callback) {
      await callback(responseContent);
    }

    return {
      success: orderResponse.success ?? false,
      text: responseText,
      data: {
        orderId: orderResponse.orderId ?? "",
        status: orderResponse.status ?? "",
        tokenId,
        side,
        price: String(price),
        size: String(size),
        timestamp: new Date().toISOString(),
      },
    };
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
