import type {
  Action,
  ActionResult,
  Content,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { ClobClient } from "@polymarket/clob-client";
import { POLYMARKET_SERVICE_NAME } from "../constants";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { PolymarketService } from "../services/polymarket";
import { getOrderDetailsTemplate } from "../templates";
import type { DetailedOrder, OrderDetailsActivityData } from "../types";
import { initializeClobClientWithCreds } from "../utils/clobClient";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

interface LLMOrderDetailsResult {
  orderId?: string;
  error?: string;
}

/**
 * Get Order Details Action for Polymarket.
 * Retrieves detailed information about a specific order by its ID.
 */
const spec = requireActionSpec("GET_ORDER_DETAILS");

export const getOrderDetailsAction: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [].map((s) => `POLYMARKET_${s}`),
  description: spec.description,

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    runtime.logger.info(
      `[getOrderDetailsAction] Validate called for message: "${message.content?.text}"`,
    );
    const clobApiUrl = runtime.getSetting("CLOB_API_URL");
    const clobApiKey = runtime.getSetting("CLOB_API_KEY");
    const clobApiSecret =
      runtime.getSetting("CLOB_API_SECRET") || runtime.getSetting("CLOB_SECRET");
    const clobApiPassphrase =
      runtime.getSetting("CLOB_API_PASSPHRASE") || runtime.getSetting("CLOB_PASS_PHRASE");
    const privateKey =
      runtime.getSetting("WALLET_PRIVATE_KEY") ||
      runtime.getSetting("PRIVATE_KEY") ||
      runtime.getSetting("POLYMARKET_PRIVATE_KEY");

    if (!clobApiUrl) {
      runtime.logger.warn("[getOrderDetailsAction] CLOB_API_URL is required.");
      return false;
    }
    if (!privateKey) {
      runtime.logger.warn(
        "[getOrderDetailsAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.",
      );
      return false;
    }
    if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
      const missing: string[] = [];
      if (!clobApiKey) missing.push("CLOB_API_KEY");
      if (!clobApiSecret) missing.push("CLOB_API_SECRET or CLOB_SECRET");
      if (!clobApiPassphrase) missing.push("CLOB_API_PASSPHRASE or CLOB_PASS_PHRASE");
      runtime.logger.warn(
        `[getOrderDetailsAction] Missing required API credentials for L2 authentication: ${missing.join(", ")}.`,
      );
      return false;
    }
    runtime.logger.info("[getOrderDetailsAction] Validation passed");
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    runtime.logger.info("[getOrderDetailsAction] Handler called!");

    const result = await callLLMWithTimeout<LLMOrderDetailsResult>(
      runtime,
      state,
      getOrderDetailsTemplate,
      "getOrderDetailsAction",
    );
    let llmResult: LLMOrderDetailsResult = {};
    if (result && !isLLMError(result)) {
      llmResult = result;
    }
    runtime.logger.info(`[getOrderDetailsAction] LLM result: ${JSON.stringify(llmResult)}`);

    if (llmResult.error || !llmResult.orderId) {
      throw new Error(llmResult.error || "Order ID not found in LLM result.");
    }

    const orderId = llmResult.orderId;

    runtime.logger.info(`[getOrderDetailsAction] Fetching details for order: ${orderId}`);

    const client = (await initializeClobClientWithCreds(runtime)) as ClobClient;
    const order: DetailedOrder = await client.getOrder(orderId);

    let responseText = `📋 **Order Details for ${orderId}**:\n\n`;

    if (order) {
      const sideEmoji = order.side === "BUY" ? "🟢" : "🔴";
      responseText += `• **Order ID**: \`${order.id}\` ${sideEmoji}\n`;
      responseText += `• **Status**: ${order.status}\n`;
      responseText += `• **Market**: ${order.market || "N/A"}\n`;
      responseText += `• **Asset ID**: \`${order.asset_id || "N/A"}\`\n`;
      responseText += `• **Side**: ${order.side}\n`;
      responseText += `• **Type**: ${order.order_type || "LIMIT"}\n`;
      responseText += `• **Price**: $${parseFloat(order.price).toFixed(4)}\n`;
      responseText += `• **Original Size**: ${order.original_size}\n`;
      responseText += `• **Size Matched**: ${order.size_matched}\n`;
      responseText += `• **Remaining Size**: ${parseFloat(order.original_size) - parseFloat(order.size_matched)}\n`;
      if (order.created_at) {
        responseText += `• **Created**: ${new Date(order.created_at).toLocaleString()}\n`;
      }
      if (order.expiration && order.expiration !== "0") {
        responseText += `• **Expiration**: ${new Date(parseInt(order.expiration, 10) * 1000).toLocaleString()}\n`;
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
      actions: ["GET_ORDER_DETAILS"],
    };

    if (callback) await callback(responseContent);

    // Record activity
    const service = runtime.getService(POLYMARKET_SERVICE_NAME) as PolymarketService | undefined;
    if (service && order) {
      const activityData: OrderDetailsActivityData = {
        type: "order_details",
        orderId: order.id,
        status: order.status,
        side: order.side,
        price: order.price,
        originalSize: order.original_size,
        sizeMatched: order.size_matched,
        market: order.market,
        assetId: order.asset_id,
      };
      await service.recordActivity(activityData);
    }

    return {
      success: true,
      text: responseText,
      data: {
        orderId: order.id,
        status: order.status,
        side: order.side,
        price: order.price,
        originalSize: order.original_size,
        sizeMatched: order.size_matched,
        timestamp: new Date().toISOString(),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Show me the details for order abc123 on Polymarket.",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Fetching details for order abc123 on Polymarket...",
          action: "POLYMARKET_GET_ORDER_DETAILS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "What is the status of my order 0xdef456 via Polymarket?",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Looking up order 0xdef456 on Polymarket...",
          action: "POLYMARKET_GET_ORDER_DETAILS",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: { text: "Show me all my open orders." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "That’s a list of open orders rather than a specific order ID. I can fetch your active orders.",
        },
      },
    ],
  ],
};
