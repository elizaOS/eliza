import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { ethers } from "ethers";

export interface ApiKeyResponse {
  id: string;
  secret: string;
  passphrase: string;
  created_at?: string;
}

interface ApiCredentialsResponse {
  api_key?: string;
  key?: string;
  id?: string;
  apiKey?: string;
  API_KEY?: string;
  api_secret?: string;
  secret?: string;
  apiSecret?: string;
  API_SECRET?: string;
  api_passphrase?: string;
  passphrase?: string;
  apiPassphrase?: string;
  API_PASSPHRASE?: string;
}

/**
 * Create API Key Action for Polymarket CLOB
 * Generates L2 authentication credentials for order posting
 */
export const createApiKeyAction: Action = {
  name: "POLYMARKET_CREATE_API_KEY",
  similes: [
    "CREATE_POLYMARKET_API_KEY",
    "GENERATE_API_CREDENTIALS",
    "CREATE_CLOB_CREDENTIALS",
    "SETUP_API_ACCESS",
  ],
  description: "Create API key credentials for Polymarket CLOB authentication",
  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "Create API key for Polymarket trading",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "I'll generate new API credentials for your Polymarket account. This will create the L2 authentication needed for order posting.",
          action: "POLYMARKET_CREATE_API_KEY",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Generate new CLOB API credentials via Polymarket",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Creating new API key credentials for Polymarket CLOB access...",
          action: "POLYMARKET_CREATE_API_KEY",
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, _message: Memory): Promise<boolean> => {
    logger.info("[createApiKeyAction] Validating action");

    const privateKey =
      runtime.getSetting("WALLET_PRIVATE_KEY") ||
      runtime.getSetting("PRIVATE_KEY") ||
      runtime.getSetting("POLYMARKET_PRIVATE_KEY");

    if (!privateKey) {
      logger.error("[createApiKeyAction] No private key found in environment");
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback: HandlerCallback
  ): Promise<Content> => {
    logger.info("[createApiKeyAction] Handler called!");

    const clobApiUrl = runtime.getSetting("CLOB_API_URL") || "https://clob.polymarket.com";

    const privateKey =
      runtime.getSetting("WALLET_PRIVATE_KEY") ||
      runtime.getSetting("PRIVATE_KEY") ||
      runtime.getSetting("POLYMARKET_PRIVATE_KEY");

    if (!privateKey) {
      throw new Error(
        "No private key found. Please set WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY in your environment"
      );
    }

    const wallet = new ethers.Wallet(privateKey);
    const address = wallet.address;

    logger.info("[createApiKeyAction] Creating API key credentials...");

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = 0;

    const domain = {
      name: "ClobAuthDomain",
      version: "1",
      chainId: 137,
    };

    const types = {
      ClobAuth: [
        { name: "address", type: "address" },
        { name: "timestamp", type: "string" },
        { name: "nonce", type: "uint256" },
        { name: "message", type: "string" },
      ],
    };

    const value = {
      address: address,
      timestamp: timestamp,
      nonce: nonce,
      message: "This message attests that I control the given wallet",
    };

    const signature = await wallet.signTypedData(domain, types, value);

    let apiCredentials: ApiCredentialsResponse | null = null;
    let isNewKey = false;

    logger.info("[createApiKeyAction] Attempting to derive existing API key...");

    const deriveResponse = await fetch(`${clobApiUrl}/auth/derive-api-key`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        POLY_ADDRESS: address,
        POLY_SIGNATURE: signature,
        POLY_TIMESTAMP: timestamp,
        POLY_NONCE: nonce.toString(),
      },
    });

    if (deriveResponse.ok) {
      apiCredentials = (await deriveResponse.json()) as ApiCredentialsResponse;
      logger.info("[createApiKeyAction] Successfully derived existing API key");
    } else {
      logger.info("[createApiKeyAction] No existing API key found, creating new one...");
      isNewKey = true;

      const createResponse = await fetch(`${clobApiUrl}/auth/api-key`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          POLY_ADDRESS: address,
          POLY_SIGNATURE: signature,
          POLY_TIMESTAMP: timestamp,
          POLY_NONCE: nonce.toString(),
        },
        body: JSON.stringify({}),
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        throw new Error(
          `API key creation failed: ${createResponse.status} ${createResponse.statusText}. ${errorText}`
        );
      }

      apiCredentials = (await createResponse.json()) as ApiCredentialsResponse;
      logger.info("[createApiKeyAction] Successfully created new API key");
    }

    if (!apiCredentials) {
      throw new Error("Failed to obtain API credentials");
    }

    logger.info("[createApiKeyAction] API key created successfully");
    logger.info("[createApiKeyAction] Raw API response:", JSON.stringify(apiCredentials, null, 2));

    const responseData: ApiKeyResponse = {
      id:
        apiCredentials.api_key ||
        apiCredentials.key ||
        apiCredentials.id ||
        apiCredentials.apiKey ||
        apiCredentials.API_KEY ||
        "",
      secret:
        apiCredentials.api_secret ||
        apiCredentials.secret ||
        apiCredentials.apiSecret ||
        apiCredentials.API_SECRET ||
        "",
      passphrase:
        apiCredentials.api_passphrase ||
        apiCredentials.passphrase ||
        apiCredentials.apiPassphrase ||
        apiCredentials.API_PASSPHRASE ||
        "",
      created_at: new Date().toISOString(),
    };

    logger.info("[createApiKeyAction] Extracted fields:", {
      id: responseData.id,
      secretLength: responseData.secret?.length,
      passphraseLength: responseData.passphrase?.length,
    });

    if (responseData.id && responseData.secret && responseData.passphrase) {
      logger.info("[createApiKeyAction] Storing API credentials in runtime settings...");

      runtime.setSetting("CLOB_API_KEY", responseData.id, false);
      runtime.setSetting("CLOB_API_SECRET", responseData.secret, true);
      runtime.setSetting("CLOB_API_PASSPHRASE", responseData.passphrase, true);

      logger.info("[createApiKeyAction] API credentials stored successfully");
    } else {
      logger.warn("[createApiKeyAction] Some credentials are missing, could not store in runtime");
    }

    const actionType = isNewKey ? "Created" : "Retrieved";
    const actionDescription = isNewKey
      ? "New credentials have been generated"
      : "Existing credentials have been retrieved";

    const successMessage = `✅ **API Key ${actionType} Successfully**

**Credentials ${actionType}:**
• **API Key**: \`${responseData.id}\`
• **Secret**: \`${responseData.secret?.substring(0, 8)}...\` (truncated for security)
• **Passphrase**: \`${responseData.passphrase?.substring(0, 8)}...\` (truncated for security)
• **${isNewKey ? "Created" : "Retrieved"}**: ${responseData.created_at}

**ℹ️ ${isNewKey ? "New API Key" : "Existing API Key"}:**
${actionDescription}

**⚠️ Security Notice:**
- Store these credentials securely
- Never share your secret or passphrase
- These credentials enable L2 authentication for order posting

**Next Steps:**
You can now place orders on Polymarket. The system will automatically use these credentials for authenticated operations.`;

    const responseContent: Content = {
      text: successMessage,
      actions: ["CREATE_API_KEY"],
      data: {
        success: true,
        apiKey: responseData,
      },
    };

    if (callback) {
      callback(responseContent);
    }

    logger.info("[createApiKeyAction] API key creation completed successfully");
    return responseContent;
  },
};
