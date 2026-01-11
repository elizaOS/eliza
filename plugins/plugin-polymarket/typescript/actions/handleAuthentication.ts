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
import { privateKeyToAccount } from "viem/accounts";

interface AuthenticationStatus {
  hasPrivateKey: boolean;
  hasApiKey: boolean;
  hasApiSecret: boolean;
  hasApiPassphrase: boolean;
  walletAddress?: string;
  isFullyAuthenticated: boolean;
  canReadMarkets: boolean;
  canTrade: boolean;
}

/**
 * Handle Authentication Action for Polymarket.
 * Checks and manages authentication status for the Polymarket CLOB API.
 */
export const handleAuthenticationAction: Action = {
  name: "POLYMARKET_HANDLE_AUTHENTICATION",
  similes: ["CHECK_AUTH", "AUTH_STATUS", "VERIFY_CREDENTIALS", "WALLET_STATUS", "LOGIN_STATUS"].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    "Checks and displays the current authentication status for Polymarket CLOB operations.",

  validate: async (_runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(
      `[handleAuthenticationAction] Validate called for message: "${message.content?.text}"`
    );
    // This action is always valid - it reports status regardless of configuration
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult> => {
    logger.info("[handleAuthenticationAction] Handler called!");

    const privateKeySetting =
      runtime.getSetting("WALLET_PRIVATE_KEY") ||
      runtime.getSetting("PRIVATE_KEY") ||
      runtime.getSetting("POLYMARKET_PRIVATE_KEY");
    const clobApiKey = runtime.getSetting("CLOB_API_KEY");
    const clobApiSecret =
      runtime.getSetting("CLOB_API_SECRET") || runtime.getSetting("CLOB_SECRET");
    const clobApiPassphrase =
      runtime.getSetting("CLOB_API_PASSPHRASE") || runtime.getSetting("CLOB_PASS_PHRASE");
    const clobApiUrl = runtime.getSetting("CLOB_API_URL");

    let walletAddress: string | undefined;
    const privateKey = privateKeySetting ? String(privateKeySetting) : null;
    if (privateKey) {
      const keyWithPrefix = (
        privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`
      ) as `0x${string}`;
      const account = privateKeyToAccount(keyWithPrefix);
      walletAddress = account.address;
    }

    const status: AuthenticationStatus = {
      hasPrivateKey: !!privateKey,
      hasApiKey: !!clobApiKey,
      hasApiSecret: !!clobApiSecret,
      hasApiPassphrase: !!clobApiPassphrase,
      walletAddress,
      isFullyAuthenticated: !!(privateKey && clobApiKey && clobApiSecret && clobApiPassphrase),
      canReadMarkets: !!clobApiUrl,
      canTrade: !!(privateKey && clobApiKey && clobApiSecret && clobApiPassphrase),
    };

    let responseText = `🔐 **Polymarket Authentication Status**\n\n`;

    // Wallet Status
    responseText += `**Wallet Configuration:**\n`;
    if (status.hasPrivateKey) {
      responseText += `✅ Private Key: Configured\n`;
      if (walletAddress) {
        responseText += `   Address: \`${walletAddress.substring(0, 6)}...${walletAddress.substring(38)}\`\n`;
      }
    } else {
      responseText += `❌ Private Key: Not configured\n`;
      responseText += `   *Set WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY*\n`;
    }

    // API Credentials Status
    responseText += `\n**API Credentials (L2 Auth):**\n`;
    responseText += `${status.hasApiKey ? "✅" : "❌"} API Key: ${status.hasApiKey ? "Configured" : "Missing (CLOB_API_KEY)"}\n`;
    responseText += `${status.hasApiSecret ? "✅" : "❌"} API Secret: ${status.hasApiSecret ? "Configured" : "Missing (CLOB_API_SECRET)"}\n`;
    responseText += `${status.hasApiPassphrase ? "✅" : "❌"} API Passphrase: ${status.hasApiPassphrase ? "Configured" : "Missing (CLOB_API_PASSPHRASE)"}\n`;

    // Capabilities
    responseText += `\n**Capabilities:**\n`;
    responseText += `${status.canReadMarkets ? "✅" : "❌"} Read Markets & Order Books: ${status.canReadMarkets ? "Available" : "Unavailable (Need CLOB_API_URL)"}\n`;
    responseText += `${status.canTrade ? "✅" : "❌"} Place Orders & Trade: ${status.canTrade ? "Available" : "Unavailable (Need full credentials)"}\n`;

    // Overall Status
    responseText += `\n**Overall Status:** `;
    if (status.isFullyAuthenticated) {
      responseText += `🟢 **Fully Authenticated**\n`;
      responseText += `You can perform all Polymarket operations including trading.\n`;
    } else if (status.canReadMarkets) {
      responseText += `🟡 **Read-Only Mode**\n`;
      responseText += `You can view markets and prices, but cannot place orders.\n`;
      if (!status.hasApiKey) {
        responseText += `\n💡 *To enable trading, run the CREATE_API_KEY action to generate L2 credentials.*\n`;
      }
    } else {
      responseText += `🔴 **Not Configured**\n`;
      responseText += `Please configure CLOB_API_URL to connect to Polymarket.\n`;
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["POLYMARKET_HANDLE_AUTHENTICATION"],
      data: {
        hasPrivateKey: status.hasPrivateKey,
        hasApiKey: status.hasApiKey,
        isFullyAuthenticated: status.isFullyAuthenticated,
        canTrade: status.canTrade,
        timestamp: new Date().toISOString(),
      },
    };

    if (callback) await callback(responseContent);
    return {
      success: true,
      text: responseText,
      data: {
        hasPrivateKey: status.hasPrivateKey,
        hasApiKey: status.hasApiKey,
        isFullyAuthenticated: status.isFullyAuthenticated,
        canTrade: status.canTrade,
        timestamp: new Date().toISOString(),
      },
    };
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: { text: "Check my Polymarket authentication status." },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Checking your Polymarket authentication and credentials...",
          action: "POLYMARKET_HANDLE_AUTHENTICATION",
        },
      },
    ],
    [
      { name: "{{user1}}", content: { text: "Am I logged into Polymarket?" } },
      {
        name: "{{user2}}",
        content: {
          text: "Let me verify your Polymarket authentication status...",
          action: "POLYMARKET_HANDLE_AUTHENTICATION",
        },
      },
    ],
  ],
};
