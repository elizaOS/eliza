import { IAgentRuntime, Memory, State, HandlerCallback, logger, Action } from '@elizaos/core';
import { initializeClobClient } from '../utils/clobClient';
import { ethers } from 'ethers';

export interface CreateApiKeyParams {
  // No parameters needed - API key generation is based on wallet signature
}

export interface ApiKeyResponse {
  id: string;
  secret: string;
  passphrase: string;
  created_at?: string;
  // Add any other fields returned by Polymarket API
}

/**
 * Create API Key Action for Polymarket CLOB
 * Generates L2 authentication credentials for order posting
 */
export const createApiKeyAction: Action = {
  name: 'POLYMARKET_CREATE_API_KEY',
  similes: [
    'CREATE_POLYMARKET_API_KEY',
    'GENERATE_API_CREDENTIALS',
    'CREATE_CLOB_CREDENTIALS',
    'SETUP_API_ACCESS',
  ],
  description: 'Create API key credentials for Polymarket CLOB authentication',
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Create API key for Polymarket trading',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll generate new API credentials for your Polymarket account. This will create the L2 authentication needed for order posting.",
          action: 'POLYMARKET_CREATE_API_KEY',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Generate new CLOB API credentials via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Creating new API key credentials for Polymarket CLOB access...',
          action: 'POLYMARKET_CREATE_API_KEY',
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    logger.info('[createApiKeyAction] Validating action');

    // Check if private key is available
    const privateKey =
      runtime.getSetting('WALLET_PRIVATE_KEY') ||
      runtime.getSetting('PRIVATE_KEY') ||
      runtime.getSetting('POLYMARKET_PRIVATE_KEY');

    if (!privateKey) {
      logger.error('[createApiKeyAction] No private key found in environment');
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
    logger.info('[createApiKeyAction] Handler called!');

    try {
      const clobApiUrl = runtime.getSetting('CLOB_API_URL') || 'https://clob.polymarket.com';

      // Get private key from environment
      const privateKey =
        runtime.getSetting('WALLET_PRIVATE_KEY') ||
        runtime.getSetting('PRIVATE_KEY') ||
        runtime.getSetting('POLYMARKET_PRIVATE_KEY');

      if (!privateKey) {
        throw new Error(
          'No private key found. Please set WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY in your environment'
        );
      }

      // Create ethers wallet for signing
      const wallet = new ethers.Wallet(privateKey);
      const address = wallet.address;

      logger.info('[createApiKeyAction] Creating API key credentials...');

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
        address: address,
        timestamp: timestamp,
        nonce: nonce,
        message: 'This message attests that I control the given wallet',
      };

      // Sign the EIP-712 message
      const signature = await wallet.signTypedData(domain, types, value);

      // First try to derive existing API key credentials
      // This is safer than always creating new ones which might fail with 400 if keys already exist
      let apiCredentials: any;
      let isNewKey = false;

      try {
        logger.info('[createApiKeyAction] Attempting to derive existing API key...');

        // Try to derive existing API key first
        const deriveResponse = await fetch(`${clobApiUrl}/auth/derive-api-key`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            POLY_ADDRESS: address,
            POLY_SIGNATURE: signature,
            POLY_TIMESTAMP: timestamp,
            POLY_NONCE: nonce.toString(),
          },
        });

        if (deriveResponse.ok) {
          apiCredentials = await deriveResponse.json();
          logger.info('[createApiKeyAction] Successfully derived existing API key');
          logger.debug(
            '[createApiKeyAction] Derive response:',
            JSON.stringify(apiCredentials, null, 2)
          );
        } else {
          throw new Error(`Derive failed: ${deriveResponse.status}`);
        }
      } catch (deriveError) {
        // If derive fails, try to create a new API key
        logger.info('[createApiKeyAction] No existing API key found, creating new one...');
        isNewKey = true;

        const createResponse = await fetch(`${clobApiUrl}/auth/api-key`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
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

        apiCredentials = await createResponse.json();
        logger.info('[createApiKeyAction] Successfully created new API key');
      }

      logger.info('[createApiKeyAction] API key created successfully');

      // Debug logging to see the actual response structure
      logger.info(
        '[createApiKeyAction] Raw API response:',
        JSON.stringify(apiCredentials, null, 2)
      );

      // Check all possible field names in the response
      const allFields = Object.keys(apiCredentials || {});
      logger.info('[createApiKeyAction] Available fields in response:', allFields);

      // Format the response with proper type handling - Polymarket uses api_key, api_secret, api_passphrase
      const responseData: ApiKeyResponse = {
        id:
          (apiCredentials as any).api_key ||
          (apiCredentials as any).key ||
          (apiCredentials as any).id ||
          (apiCredentials as any).apiKey ||
          (apiCredentials as any).API_KEY,
        secret:
          (apiCredentials as any).api_secret ||
          (apiCredentials as any).secret ||
          (apiCredentials as any).apiSecret ||
          (apiCredentials as any).API_SECRET,
        passphrase:
          (apiCredentials as any).api_passphrase ||
          (apiCredentials as any).passphrase ||
          (apiCredentials as any).apiPassphrase ||
          (apiCredentials as any).API_PASSPHRASE,
        created_at: new Date().toISOString(),
      };

      // Debug logging to see what we extracted
      logger.info('[createApiKeyAction] Extracted fields:', {
        id: responseData.id,
        secretLength: responseData.secret?.length,
        passphraseLength: responseData.passphrase?.length,
      });

      // Store the credentials in runtime settings for other actions to use
      // This allows get/delete API key actions to work without requiring env vars
      if (responseData.id && responseData.secret && responseData.passphrase) {
        logger.info('[createApiKeyAction] Storing API credentials in runtime settings...');

        // Use the proper runtime.setSetting method
        runtime.setSetting('CLOB_API_KEY', responseData.id, false);
        runtime.setSetting('CLOB_API_SECRET', responseData.secret, true); // Mark secret as sensitive
        runtime.setSetting('CLOB_API_PASSPHRASE', responseData.passphrase, true); // Mark passphrase as sensitive

        logger.info('[createApiKeyAction] API credentials stored successfully');

        // Verify storage by immediately retrieving the values
        const storedApiKey = runtime.getSetting('CLOB_API_KEY');
        const storedApiSecret = runtime.getSetting('CLOB_API_SECRET');
        const storedApiPassphrase = runtime.getSetting('CLOB_API_PASSPHRASE');

        logger.info('[createApiKeyAction] Verification of stored credentials:', {
          storedApiKeyLength: storedApiKey?.length,
          storedSecretLength: storedApiSecret?.length,
          storedPassphraseLength: storedApiPassphrase?.length,
          keysMatch: storedApiKey === responseData.id,
          secretsMatch: storedApiSecret === responseData.secret,
          passphrasesMatch: storedApiPassphrase === responseData.passphrase,
        });
      } else {
        logger.warn(
          '[createApiKeyAction] Some credentials are missing, could not store in runtime'
        );
        logger.warn('[createApiKeyAction] Missing fields:', {
          hasId: !!responseData.id,
          hasSecret: !!responseData.secret,
          hasPassphrase: !!responseData.passphrase,
        });
      }

      // Create success message
      const actionType = isNewKey ? 'Created' : 'Retrieved';
      const actionDescription = isNewKey
        ? 'New credentials have been generated'
        : 'Existing credentials have been retrieved';

      const successMessage = `✅ **API Key ${actionType} Successfully**

**Credentials ${actionType}:**
• **API Key**: \`${responseData.id}\`
• **Secret**: \`${responseData.secret?.substring(0, 8)}...\` (truncated for security)
• **Passphrase**: \`${responseData.passphrase?.substring(0, 8)}...\` (truncated for security)
• **${isNewKey ? 'Created' : 'Retrieved'}**: ${responseData.created_at}

**ℹ️ ${isNewKey ? 'New API Key' : 'Existing API Key'}:**
${actionDescription}

**⚠️ Security Notice:**
- Store these credentials securely
- Never share your secret or passphrase
- These credentials enable L2 authentication for order posting

**Next Steps:**
You can now place orders on Polymarket. The system will automatically use these credentials for authenticated operations.`;

      // Call callback with success response
      if (callback) {
        callback({
          text: successMessage,
          action: 'CREATE_API_KEY',
          data: {
            success: true,
            apiKey: responseData,
          },
        });
      }

      logger.info('[createApiKeyAction] API key creation completed successfully');
    } catch (error) {
      logger.error('[createApiKeyAction] Error creating API key:', error);

      const errorMessage = `❌ **API Key Creation Failed**

**Error**: ${error instanceof Error ? error.message : 'Unknown error occurred'}

**Possible Causes:**
• Network connectivity issues
• Invalid private key configuration
• Polymarket API rate limiting
• Account restrictions

**Please check:**
• Your private key is valid and properly set
• Network connection is stable
• Try again in a few moments`;

      if (callback) {
        callback({
          text: errorMessage,
          action: 'CREATE_API_KEY',
          data: {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }
    }
  },
};
