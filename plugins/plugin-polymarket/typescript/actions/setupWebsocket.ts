import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { setupWebsocketTemplate } from "../templates";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

interface LLMWebsocketSetupResult {
  channels?: string[];
  assetIds?: string[];
  authenticated?: boolean;
  error?: string;
}

interface WebsocketConfig {
  url: string;
  channels: string[];
  assetIds: string[];
  authenticated: boolean;
  status: "disconnected" | "connecting" | "connected" | "error";
}

/**
 * Setup WebSocket Action for Polymarket.
 * Configures and initializes WebSocket connections for real-time data.
 */
export const setupWebsocketAction: Action = {
  name: "POLYMARKET_SETUP_WEBSOCKET",
  similes: ["CONNECT_WEBSOCKET", "INIT_WS", "START_STREAM", "ENABLE_REALTIME"].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    "Sets up and configures WebSocket connections for real-time Polymarket data streaming.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(`[setupWebsocketAction] Validate called for message: "${message.content?.text}"`);
    const clobWsUrl = runtime.getSetting("CLOB_WS_URL");

    if (!clobWsUrl) {
      logger.warn("[setupWebsocketAction] CLOB_WS_URL is required for WebSocket connections.");
      return false;
    }
    logger.info("[setupWebsocketAction] Validation passed");
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info("[setupWebsocketAction] Handler called!");

    let llmResult: LLMWebsocketSetupResult = {};
    try {
      const result = await callLLMWithTimeout<LLMWebsocketSetupResult>(
        runtime,
        state,
        setupWebsocketTemplate,
        "setupWebsocketAction"
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[setupWebsocketAction] LLM result: ${JSON.stringify(llmResult)}`);
    } catch (error) {
      logger.warn("[setupWebsocketAction] LLM extraction failed, using defaults", error);
    }

    const channels = llmResult.channels || ["book", "price"];
    const assetIds = llmResult.assetIds || [];
    const authenticated = llmResult.authenticated || false;

    const clobWsUrl = runtime.getSetting("CLOB_WS_URL");

    logger.info(
      `[setupWebsocketAction] Setting up WebSocket with channels: ${channels.join(", ")}`
    );

    try {
      // Note: Actual WebSocket connection would be managed by a service.
      // This action configures and provides status information.

      const config: WebsocketConfig = {
        url: String(clobWsUrl || ""),
        channels,
        assetIds,
        authenticated,
        status: "disconnected", // Would be 'connected' if service is running
      };

      let responseText = `🔌 **Polymarket WebSocket Configuration**\n\n`;

      responseText += `**Connection Settings:**\n`;
      responseText += `• **URL**: ${config.url || "Not configured"}\n`;
      responseText += `• **Status**: ${config.status === "connected" ? "🟢 Connected" : "⚪ Disconnected"}\n`;
      responseText += `• **Authenticated**: ${authenticated ? "✅ Yes" : "❌ No"}\n\n`;

      responseText += `**Requested Channels:**\n`;
      channels.forEach((channel: string) => {
        const descriptions: Record<string, string> = {
          book: "Order book updates",
          price: "Price tick updates",
          trade: "Trade execution updates",
          ticker: "Market ticker updates",
          user: "User order/fill updates (requires auth)",
        };
        responseText += `• \`${channel}\`: ${descriptions[channel] || "Unknown channel"}\n`;
      });

      if (assetIds.length > 0) {
        responseText += `\n**Assets to Subscribe:**\n`;
        assetIds.forEach((assetId: string) => {
          responseText += `• \`${assetId}\`\n`;
        });
      } else {
        responseText += `\n**Assets**: None specified (specify asset IDs to subscribe)\n`;
      }

      responseText += `\n**WebSocket Message Format:**\n`;
      responseText += "```json\n";
      responseText += JSON.stringify(
        {
          type: "subscribe",
          channel: channels[0] || "book",
          assets_ids: assetIds.length > 0 ? assetIds : ["<asset_id>"],
        },
        null,
        2
      );
      responseText += "\n```\n";

      if (authenticated) {
        const hasCredentials =
          runtime.getSetting("CLOB_API_KEY") &&
          runtime.getSetting("CLOB_API_SECRET") &&
          runtime.getSetting("CLOB_API_PASSPHRASE");

        if (hasCredentials) {
          responseText += `\n✅ *API credentials available for authenticated channels.*\n`;
        } else {
          responseText += `\n⚠️ *Authenticated channels requested but API credentials not fully configured.*\n`;
        }
      }

      responseText += `\n💡 *To start the WebSocket connection, the PolymarketService must be initialized.*\n`;
      responseText += `*Use the service's startWebSocket method with this configuration.*\n`;

      const responseContent: Content = {
        text: responseText,
        actions: ["POLYMARKET_SETUP_WEBSOCKET"],
        data: {
          config,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error("[setupWebsocketAction] Error setting up WebSocket:", error);
      const errorMessage = error instanceof Error ? error.message : "Unknown error occurred.";
      const errorContent: Content = {
        text: `❌ **Error setting up WebSocket**: ${errorMessage}`,
        actions: ["POLYMARKET_SETUP_WEBSOCKET"],
        data: {
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
        name: "{{user1}}",
        content: { text: "Setup WebSocket for Polymarket price updates." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Configuring WebSocket connection for Polymarket price streaming...",
          action: "POLYMARKET_SETUP_WEBSOCKET",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Connect to Polymarket order book stream for token xyz123.",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Setting up WebSocket for order book updates on token xyz123...",
          action: "POLYMARKET_SETUP_WEBSOCKET",
        },
      },
    ],
  ],
};
