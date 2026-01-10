import { IAgentRuntime, Memory, State, HandlerCallback, logger } from '@elizaos/core';
import { initializeClobClientWithCreds } from '../utils/clobClient';

export interface ApiKeyData {
  key: string;
  secret?: string;
  passphrase?: string;
  created_at?: string;
  active?: boolean;
  permissions?: string[];
  label?: string;
}

export interface GetAllApiKeysResponse {
  success: boolean;
  apiKeys: ApiKeyData[];
  count: number;
  address: string;
}

/**
 * Get All API Keys Action for Polymarket CLOB
 * Retrieves all API keys associated with a Polygon address using ClobClient.getApiKeys()
 */
export const getAllApiKeysAction = {
  name: 'POLYMARKET_GET_API_KEYS',
  similes: [
    'GET_ALL_API_KEYS',
    'LIST_API_KEYS',
    'RETRIEVE_API_KEYS',
    'SHOW_API_KEYS',
    'GET_POLYMARKET_API_KEYS',
    'LIST_CLOB_CREDENTIALS',
    'SHOW_MY_API_KEYS',
  ],
  description: 'Retrieve all API keys associated with your Polymarket account',
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Get my API keys via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll retrieve all API keys associated with your Polymarket account.",
          action: 'POLYMARKET_GET_API_KEYS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Show me all my CLOB API credentials via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Retrieving your Polymarket API keys...',
          action: 'POLYMARKET_GET_API_KEYS',
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    logger.info('[getAllApiKeysAction] Validating action');

    // Check if private key is available for authentication
    const privateKey =
      runtime.getSetting('WALLET_PRIVATE_KEY') ||
      runtime.getSetting('PRIVATE_KEY') ||
      runtime.getSetting('POLYMARKET_PRIVATE_KEY');

    if (!privateKey) {
      logger.error('[getAllApiKeysAction] No private key found in environment');
      return false;
    }

    // Check if API credentials are available in environment variables first
    const envApiKey = runtime.getSetting('CLOB_API_KEY');
    const envApiSecret = runtime.getSetting('CLOB_API_SECRET') || runtime.getSetting('CLOB_SECRET');
    const envApiPassphrase =
      runtime.getSetting('CLOB_API_PASSPHRASE') || runtime.getSetting('CLOB_PASS_PHRASE');

    if (!envApiKey || !envApiSecret || !envApiPassphrase) {
      logger.error('[getAllApiKeysAction] API credentials not found in environment variables');
      logger.error(
        '[getAllApiKeysAction] Please set: CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE'
      );
      return false;
    }

    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: any,
    callback: HandlerCallback
  ): Promise<void> => {
    logger.info('[getAllApiKeysAction] Handler called!');

    try {
      // Check for API credentials in both runtime settings and environment variables
      let apiKey = runtime.getSetting('CLOB_API_KEY');
      let apiSecret = runtime.getSetting('CLOB_API_SECRET') || runtime.getSetting('CLOB_SECRET');
      let apiPassphrase =
        runtime.getSetting('CLOB_API_PASSPHRASE') || runtime.getSetting('CLOB_PASS_PHRASE');

      logger.info('[getAllApiKeysAction] Checking for API credentials...');
      logger.info('[getAllApiKeysAction] Found credentials:', {
        hasApiKey: !!apiKey,
        hasApiSecret: !!apiSecret,
        hasApiPassphrase: !!apiPassphrase,
        apiKeySource: apiKey ? (runtime.getSetting('CLOB_API_KEY') ? 'runtime' : 'env') : 'none',
      });

      if (!apiKey || !apiSecret || !apiPassphrase) {
        const helpMessage = `❌ **Failed to Retrieve API Keys**

**Error**: API credentials not found. Please set up your Polymarket API credentials.

**Required Environment Variables:**
• **CLOB_API_KEY**: Your Polymarket API key ID
• **CLOB_API_SECRET**: Your Polymarket API secret  
• **CLOB_API_PASSPHRASE**: Your Polymarket API passphrase

**How to Set Up:**
1. First create API keys using: "create an api key for polymarket"
2. Copy the returned credentials to your .env file:
   \`\`\`
   CLOB_API_KEY=your-api-key-here
   CLOB_API_SECRET=your-api-secret-here
   CLOB_API_PASSPHRASE=your-api-passphrase-here
   \`\`\`
3. Restart the application to load the new environment variables

**Alternative Names Supported:**
• CLOB_SECRET (instead of CLOB_API_SECRET)
• CLOB_PASS_PHRASE (instead of CLOB_API_PASSPHRASE)`;

        if (callback) {
          callback({
            text: helpMessage,
            action: 'POLYMARKET_GET_API_KEYS',
            data: {
              success: false,
              error: 'API credentials not found - see setup instructions above',
            },
          });
        }
        return;
      }

      // Initialize CLOB client with API credentials
      logger.info('[getAllApiKeysAction] Initializing CLOB client with credentials...');
      const clobClient = await initializeClobClientWithCreds(runtime);

      // Get wallet address for response
      const privateKey =
        runtime.getSetting('WALLET_PRIVATE_KEY') ||
        runtime.getSetting('PRIVATE_KEY') ||
        runtime.getSetting('POLYMARKET_PRIVATE_KEY');

      const { ethers } = await import('ethers');
      const wallet = new ethers.Wallet(privateKey!);
      const address = wallet.address;

      logger.info(`[getAllApiKeysAction] Retrieving API keys for address: ${address}`);

      // Use ClobClient's getApiKeys method
      logger.info('[getAllApiKeysAction] Calling clobClient.getApiKeys()...');
      const apiKeysResponse = await clobClient.getApiKeys();

      logger.info(
        '[getAllApiKeysAction] Raw response from ClobClient:',
        JSON.stringify(apiKeysResponse, null, 2)
      );

      // Format the response - handle different response structures
      let apiKeys: ApiKeyData[] = [];

      // Handle the specific case where apiKeysResponse is { apiKeys: ["id1", "id2"] }
      if (
        apiKeysResponse &&
        Array.isArray((apiKeysResponse as any).apiKeys) &&
        (apiKeysResponse as any).apiKeys.every((k: any) => typeof k === 'string')
      ) {
        apiKeys = (apiKeysResponse as any).apiKeys.map((keyId: string) => ({
          key: keyId,
          // Other fields will be undefined as only IDs are provided in this format
          active: true, // Assume active if listed
          permissions: ['trading'], // Default assumption
        }));
      } else if (Array.isArray(apiKeysResponse)) {
        // Response is directly an array of more detailed key objects (original handling)
        apiKeys = apiKeysResponse.map((key: any) => ({
          key: key.key || key.api_key || key.id || key.key_id, // Added key_id
          secret: key.secret || key.api_secret,
          passphrase: key.passphrase || key.api_passphrase,
          created_at: key.created_at || key.createdAt,
          active: key.active !== undefined ? key.active : key.status === 'active', // Added status check
          permissions: key.permissions || ['trading'],
          label: key.label,
        }));
      } else if (
        apiKeysResponse &&
        typeof apiKeysResponse === 'object' &&
        (apiKeysResponse as any).data &&
        Array.isArray((apiKeysResponse as any).data)
      ) {
        // Response is an object with a data field containing an array of detailed key objects
        apiKeys = (apiKeysResponse as any).data.map((key: any) => ({
          key: key.key || key.api_key || key.id || key.key_id,
          secret: key.secret || key.api_secret,
          passphrase: key.passphrase || key.api_passphrase,
          created_at: key.created_at || key.createdAt,
          active: key.active !== undefined ? key.active : key.status === 'active',
          permissions: key.permissions || ['trading'],
          label: key.label,
        }));
      } else if (
        apiKeysResponse &&
        typeof apiKeysResponse === 'object' &&
        ((apiKeysResponse as any).key ||
          (apiKeysResponse as any).api_key ||
          (apiKeysResponse as any).id ||
          (apiKeysResponse as any).key_id)
      ) {
        // Response is a single detailed key object (less common for a "get all" type endpoint but handle defensively)
        const key = apiKeysResponse as any;
        apiKeys = [
          {
            key: key.key || key.api_key || key.id || key.key_id,
            secret: key.secret || key.api_secret,
            passphrase: key.passphrase || key.api_passphrase,
            created_at: key.created_at || key.createdAt,
            active: key.active !== undefined ? key.active : key.status === 'active',
            permissions: key.permissions || ['trading'],
            label: key.label,
          },
        ];
      } // No further specific single object check if it doesn't have key identifier, covered by initial {apiKeys: [...]} check

      const responseData: GetAllApiKeysResponse = {
        success: true,
        apiKeys: apiKeys,
        count: apiKeys.length,
        address: address,
      };

      logger.info(`[getAllApiKeysAction] Processed ${responseData.count} API keys`);

      // Create success message
      let successMessage = `✅ **API Keys Retrieved Successfully**

**Account Address**: \`${address}\`
**Total API Keys**: ${responseData.count}

`;

      if (responseData.count === 0) {
        successMessage += `**No API keys found** for your account (Wallet: \`${address}\`).\n`;
      } else {
        successMessage += '**API Key Details**:\n\n';
        responseData.apiKeys.forEach((apiKeyData, index) => {
          successMessage += `**Key ${index + 1}:**\n`;
          successMessage += `• **ID**: \`${apiKeyData.key}\`\n`;
          // Only show other details if they exist (they won't for the simple ID list case)
          if (apiKeyData.label) {
            successMessage += `• **Label**: \`${apiKeyData.label}\`\n`;
          }
          if (apiKeyData.created_at) {
            successMessage += `• **Created**: ${new Date(apiKeyData.created_at).toLocaleString()}\n`;
          }
          if (apiKeyData.permissions) {
            successMessage += `• **Permissions**: ${apiKeyData.permissions.join(', ')}\n`;
          }
          successMessage += `• **Status**: ${apiKeyData.active ? '🟢 Active' : '🔴 Inactive'}\n\n`;
        });
      }

      successMessage += `**⚠️ Security Notice:**
- Keep these credentials secure and private
- Each API key provides L2 authentication for order posting
- You can revoke unused keys with the DELETE_API_KEY action`;

      // Call callback with success response
      if (callback) {
        await callback({
          text: successMessage,
          action: 'POLYMARKET_GET_API_KEYS',
          data: responseData,
        });
      }

      logger.info('[getAllApiKeysAction] API keys retrieval completed successfully');
    } catch (error) {
      logger.error('[getAllApiKeysAction] Error retrieving API keys:', error);

      const errorMessage = `❌ **Failed to Retrieve API Keys**

**Error**: ${error instanceof Error ? error.message : 'Unknown error occurred'}

**Possible Causes:**
• No API credentials configured (need to create API keys first)
• Invalid API credentials or they have been revoked
• Network connectivity issues
• Polymarket API rate limiting

**Next Steps:**
• If you haven't created API keys yet, use the CREATE_API_KEY action
• Verify your CLOB_API_KEY, CLOB_API_SECRET, and CLOB_API_PASSPHRASE are correct
• Check your network connection and try again`;

      if (callback) {
        callback({
          text: errorMessage,
          action: 'POLYMARKET_GET_API_KEYS',
          data: {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }
    }
  },
};
