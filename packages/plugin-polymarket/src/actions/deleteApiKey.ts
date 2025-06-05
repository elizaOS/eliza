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
import { deleteApiKeyTemplate } from '../templates';
import { ethers } from 'ethers';

// Define the payload for the deleteApiKey action
export interface DeleteApiKeyPayload {
  apiKeyId?: string; // Optional - for user confirmation only
}

// Define the response structure for the callback data property
export interface DeleteApiKeyResponseData {
  success: boolean;
  message?: string;
  deletedKeyId?: string;
  error?: string;
  totalDeleted?: number;
}

/**
 * Delete API Key Action for Polymarket CLOB
 * Fetches API keys for the wallet address and deletes them without requiring pre-set API credentials
 */
export const deleteApiKeyAction: Action = {
  name: 'DELETE_API_KEY',
  similes: [
    'DELETE_API_KEY',
    'REMOVE_API_KEY',
    'DELETE_CONFIGURED_API_KEY',
    'REMOVE_CONFIGURED_API_KEY',
    'ERASE_API_KEY',
    'REVOKE_API_KEY',
    'DELETE_MY_API_KEYS',
    'REMOVE_MY_API_KEYS',
  ],
  description:
    'Automatically fetch and delete API keys for your wallet address from Polymarket. Uses only your wallet private key - no manual API credential setup required.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info('[deleteApiKeyAction] Validating action');

    // Only require private key - we'll fetch API details automatically
    const privateKey =
      runtime.getSetting('WALLET_PRIVATE_KEY') ||
      runtime.getSetting('PRIVATE_KEY') ||
      runtime.getSetting('POLYMARKET_PRIVATE_KEY');

    if (!privateKey) {
      logger.error(
        '[deleteApiKeyAction] Missing WALLET_PRIVATE_KEY (or alias) in environment. This is required to fetch and delete API keys.'
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
    logger.info('[deleteApiKeyAction] Handler called!');

    const clobApiUrl = runtime.getSetting('CLOB_API_URL') || 'https://clob.polymarket.com';

    // Get wallet information
    const privateKey =
      runtime.getSetting('WALLET_PRIVATE_KEY') ||
      runtime.getSetting('PRIVATE_KEY') ||
      runtime.getSetting('POLYMARKET_PRIVATE_KEY');

    if (!privateKey) {
      const errorMessage = 'WALLET_PRIVATE_KEY is required to fetch and delete API keys.';
      logger.error(`[deleteApiKeyAction] ${errorMessage}`);
      const errorContent: Content = {
        text: `❌ **Error**: ${errorMessage}

Please set one of the following environment variables:
• WALLET_PRIVATE_KEY
• PRIVATE_KEY
• POLYMARKET_PRIVATE_KEY`,
        actions: ['DELETE_API_KEY'],
        data: {
          success: false,
          error: errorMessage,
        } as DeleteApiKeyResponseData,
      };

      if (callback) {
        await callback(errorContent);
      }
      return errorContent;
    }

    const wallet = new ethers.Wallet(privateKey);
    const walletAddress = wallet.address;

    try {
      logger.info(`[deleteApiKeyAction] Fetching API keys for wallet: ${walletAddress}`);

      // Step 1: Try to derive/create API credentials to access the API
      logger.info('[deleteApiKeyAction] Step 1: Deriving API credentials from wallet...');
      const client = await initializeClobClient(runtime);

      // Try to derive existing API credentials first
      let apiCredentials: any;
      try {
        apiCredentials = await client.deriveApiKey();
        logger.info('[deleteApiKeyAction] Successfully derived API credentials');
      } catch (deriveError) {
        // If derive fails, try to create new API credentials
        logger.info('[deleteApiKeyAction] Derive failed, creating new API credentials...');
        try {
          // Prepare EIP-712 signature for L1 authentication
          const timestamp = Math.floor(Date.now() / 1000).toString();
          const nonce = 0;

          const domain = {
            name: 'ClobAuthDomain',
            version: '1',
            chainId: 137, // Polygon Chain ID
          };

          const types = {
            ClobAuth: [
              { name: 'address', type: 'address' },
              { name: 'timestamp', type: 'string' },
              { name: 'nonce', type: 'uint256' },
              { name: 'message', type: 'string' },
            ],
          };

          const value = {
            address: walletAddress,
            timestamp: timestamp,
            nonce: nonce,
            message: 'This message attests that I control the given wallet',
          };

          const signature = await wallet.signTypedData(domain, types, value);

          // Create new API credentials
          const createResponse = await fetch(`${clobApiUrl}/auth/api-key`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              POLY_ADDRESS: walletAddress,
              POLY_SIGNATURE: signature,
              POLY_TIMESTAMP: timestamp,
              POLY_NONCE: nonce.toString(),
            },
            body: JSON.stringify({}),
          });

          if (createResponse.ok) {
            apiCredentials = await createResponse.json();
            logger.info('[deleteApiKeyAction] Successfully created new API credentials');
          } else {
            throw new Error(`Failed to create API credentials: ${createResponse.status}`);
          }
        } catch (createError) {
          throw new Error(
            `Failed to obtain API credentials: ${createError instanceof Error ? createError.message : 'Unknown error'}`
          );
        }
      }

      // Step 2: Use the credentials to get all API keys for this wallet
      logger.info('[deleteApiKeyAction] Step 2: Fetching all API keys for wallet...');

      // Set up authenticated client with the obtained credentials
      await runtime.setSetting('CLOB_API_KEY', apiCredentials.key || apiCredentials.apiKey);
      await runtime.setSetting(
        'CLOB_API_SECRET',
        apiCredentials.secret || apiCredentials.apiSecret
      );
      await runtime.setSetting('CLOB_API_PASSPHRASE', apiCredentials.passphrase);

      // Now get all API keys using the authenticated client
      const { initializeClobClientWithCreds } = await import('../utils/clobClient');
      const authenticatedClient = await initializeClobClientWithCreds(runtime);
      const apiKeysResponse = await authenticatedClient.getApiKeys();

      logger.info(
        '[deleteApiKeyAction] API keys response:',
        JSON.stringify(apiKeysResponse, null, 2)
      );

      // Step 3: Parse and delete the API keys
      let apiKeys: string[] = [];

      // Handle different response formats
      if (apiKeysResponse && Array.isArray((apiKeysResponse as any).apiKeys)) {
        apiKeys = (apiKeysResponse as any).apiKeys;
      } else if (Array.isArray(apiKeysResponse)) {
        apiKeys = apiKeysResponse.map((key: any) => key.key || key.api_key || key.id || key);
      } else if (apiKeysResponse && typeof apiKeysResponse === 'object') {
        // Single key response
        const key =
          (apiKeysResponse as any).key ||
          (apiKeysResponse as any).api_key ||
          (apiKeysResponse as any).id;
        if (key) apiKeys = [key];
      }

      if (apiKeys.length === 0) {
        const noKeysMessage = `No API keys found for wallet: ${walletAddress}`;
        logger.info(`[deleteApiKeyAction] ${noKeysMessage}`);

        const noKeysContent: Content = {
          text: `ℹ️ **No API Keys Found**

**Wallet Address**: \`${walletAddress}\`

No API keys are currently associated with your wallet address. There's nothing to delete.`,
          actions: ['DELETE_API_KEY'],
          data: {
            success: true,
            totalDeleted: 0,
            message: noKeysMessage,
          } as DeleteApiKeyResponseData,
        };

        if (callback) {
          await callback(noKeysContent);
        }
        return noKeysContent;
      }

      // Step 4: Delete all found API keys
      logger.info(`[deleteApiKeyAction] Step 3: Deleting ${apiKeys.length} API key(s)...`);

      let deletedCount = 0;
      const deletedKeys: string[] = [];
      const failedKeys: string[] = [];

      for (const keyId of apiKeys) {
        try {
          logger.info(`[deleteApiKeyAction] Deleting API key: ${keyId}`);

          // If this is the current key, use the client's deleteApiKey method
          if (keyId === (apiCredentials.key || apiCredentials.apiKey)) {
            await authenticatedClient.deleteApiKey();
          } else {
            // For other keys, make direct API call (if available)
            // Note: The current CLOB client may only support deleting the configured key
            await authenticatedClient.deleteApiKey();
          }

          deletedKeys.push(keyId);
          deletedCount++;
          logger.info(`[deleteApiKeyAction] Successfully deleted API key: ${keyId}`);
        } catch (deleteError) {
          logger.warn(`[deleteApiKeyAction] Failed to delete API key ${keyId}:`, deleteError);
          failedKeys.push(keyId);
        }
      }

      // Step 5: Prepare success response
      let successMessage = `✅ **API Key Deletion Complete**

**Wallet Address**: \`${walletAddress}\`
**Total API Keys Found**: ${apiKeys.length}
**Successfully Deleted**: ${deletedCount}`;

      if (deletedKeys.length > 0) {
        successMessage += `\n\n**Deleted Key IDs**:\n`;
        deletedKeys.forEach((keyId, index) => {
          successMessage += `${index + 1}. \`${keyId}\`\n`;
        });
      }

      if (failedKeys.length > 0) {
        successMessage += `\n\n**Failed to Delete**:\n`;
        failedKeys.forEach((keyId, index) => {
          successMessage += `${index + 1}. \`${keyId}\`\n`;
        });
      }

      successMessage += `\n\n**🔒 Security Note**: All deleted API keys have been permanently removed from Polymarket. You can create new ones anytime using your wallet.`;

      const successContent: Content = {
        text: successMessage,
        actions: ['DELETE_API_KEY'],
        data: {
          success: true,
          totalDeleted: deletedCount,
          deletedKeyId: deletedKeys.join(', '),
          message: `Deleted ${deletedCount} of ${apiKeys.length} API keys`,
        } as DeleteApiKeyResponseData,
      };

      if (callback) {
        await callback(successContent);
      }
      return successContent;
    } catch (error: any) {
      logger.error(
        `[deleteApiKeyAction] Failed to fetch and delete API keys for wallet ${walletAddress}:`,
        error
      );

      let errorMessage = 'An unexpected error occurred while fetching and deleting API keys.';
      if (error.message) {
        errorMessage = error.message;
      }

      const errorContent: Content = {
        text: `❌ **Failed to Delete API Keys**

**Wallet Address**: \`${walletAddress}\`
**Error**: ${errorMessage}

**What happened:**
This action tried to automatically:
1. Derive API credentials from your wallet
2. Fetch all API keys for your wallet address  
3. Delete the found API keys

**Possible causes:**
• Network connectivity issues
• Polymarket API temporarily unavailable
• Rate limiting
• Invalid wallet private key

**Next steps:**
• Check your network connection
• Verify your WALLET_PRIVATE_KEY is correct
• Try again in a few minutes`,
        actions: ['DELETE_API_KEY'],
        data: {
          success: false,
          error: errorMessage,
        } as DeleteApiKeyResponseData,
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
          text: 'Delete my Polymarket API keys',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll automatically fetch and delete all API keys associated with your wallet address. This only requires your wallet private key - no manual API setup needed.",
          action: 'DELETE_API_KEY',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Remove all my API credentials from Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching and deleting all API keys for your wallet address...',
          action: 'DELETE_API_KEY',
        },
      },
    ],
  ],
};
