import { IAgentRuntime, Memory, State, HandlerCallback, logger } from '@elizaos/core';
import { initializeClobClient } from '../utils/clobClient';
import { callLLMWithTimeout } from '../utils/llmHelpers';
import { ethers } from 'ethers';

export interface RevokeApiKeyParams {
  apiKeyId: string;
}

export interface RevokeApiKeyResponse {
  success: boolean;
  apiKeyId: string;
  revokedAt: string;
  message: string;
}

/**
 * Revoke API Key Action for Polymarket CLOB
 * Deletes/revokes an existing API key to disable L2 authentication
 */
export const revokeApiKeyAction = {
  name: 'POLYMARKET_DELETE_API_KEY',
  similes: [
    'REVOKE_API_KEY',
    'DELETE_POLYMARKET_API_KEY',
    'REMOVE_API_CREDENTIALS',
    'REVOKE_CLOB_CREDENTIALS',
    'DELETE_API_ACCESS',
    'DISABLE_API_KEY',
  ],
  description: 'Revoke/delete an existing API key for Polymarket CLOB authentication',
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Revoke API key 12345678-1234-5678-9abc-123456789012 via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll revoke the specified API key via Polymarket. This will disable L2 authentication for that key.",
          action: 'POLYMARKET_DELETE_API_KEY',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Delete my CLOB API credentials via Polymarket',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Revoking your API key credentials via Polymarket...',
          action: 'POLYMARKET_DELETE_API_KEY',
        },
      },
    ],
  ],

  validate: async (runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    logger.info('[revokeApiKeyAction] Validating action');

    // Check if private key is available for authentication
    const privateKey =
      runtime.getSetting('WALLET_PRIVATE_KEY') ||
      runtime.getSetting('PRIVATE_KEY') ||
      runtime.getSetting('POLYMARKET_PRIVATE_KEY');

    if (!privateKey) {
      logger.error('[revokeApiKeyAction] No private key found in environment');
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
    logger.info('[revokeApiKeyAction] Handler called!');

    try {
      // Extract API key ID from user message using LLM
      const extractionPrompt = `
Extract the API key ID from this message about revoking/deleting an API key:
"${message.content.text}"

Return ONLY the API key ID (UUID format like 12345678-1234-5678-9abc-123456789012) or "NONE" if no valid API key ID is found.

Examples:
- "Revoke API key 12345678-1234-5678-9abc-123456789012" → "12345678-1234-5678-9abc-123456789012"
- "Delete my CLOB API credentials" → "NONE"
- "Remove key abc12345-def6-7890-ghij-klmnopqrstuv" → "abc12345-def6-7890-ghij-klmnopqrstuv"
`;

      logger.info('[revokeApiKeyAction] Starting LLM parameter extraction...');

      const extractedApiKeyId = await callLLMWithTimeout(
        runtime,
        state,
        extractionPrompt,
        'revokeApiKeyAction',
        5000
      );

      logger.debug(`[revokeApiKeyAction] Parsed LLM parameters:`, extractedApiKeyId);

      // Handle both string and object responses from LLM
      let apiKeyIdString: string;
      if (typeof extractedApiKeyId === 'object' && extractedApiKeyId !== null) {
        // If it's an object like {"api_key_id": "NONE"} or {"result": "NONE"}, extract the result
        apiKeyIdString =
          (extractedApiKeyId as any).api_key_id ||
          (extractedApiKeyId as any).result ||
          (extractedApiKeyId as any).apiKeyId ||
          String(extractedApiKeyId);
      } else {
        apiKeyIdString = String(extractedApiKeyId || '');
      }

      if (!apiKeyIdString || apiKeyIdString.trim() === 'NONE' || apiKeyIdString.trim() === '') {
        const errorMessage = `❌ **API Key Revocation Failed**

**Error**: No valid API key ID provided

**Required Format**: Please provide the API key ID in UUID format
**Example**: \`12345678-1234-5678-9abc-123456789012\`

**Usage Examples**:
• "Revoke API key 12345678-1234-5678-9abc-123456789012"
• "Delete API key abc12345-def6-7890-ghij-klmnopqrstuv"`;

        if (callback) {
          callback({
            text: errorMessage,
            action: 'POLYMARKET_DELETE_API_KEY',
            data: {
              success: false,
              error: 'No valid API key ID provided',
            },
          });
        }
        return;
      }

      const apiKeyId = apiKeyIdString.trim();
      logger.info(`[revokeApiKeyAction] Extracted API key ID: ${apiKeyId}`);

      // Get API credentials for L2 authentication
      const apiKey = runtime.getSetting('CLOB_API_KEY');
      const apiSecret = runtime.getSetting('CLOB_API_SECRET');
      const apiPassphrase = runtime.getSetting('CLOB_API_PASSPHRASE');

      if (!apiKey || !apiSecret || !apiPassphrase) {
        throw new Error(
          'API credentials not found. You need to create API keys first using the CREATE_API_KEY action'
        );
      }

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

      // Create ethers wallet for authentication
      const wallet = new ethers.Wallet(privateKey);
      const address = wallet.address;

      logger.info('[revokeApiKeyAction] Revoking API key...');

      // Prepare L2 authentication headers
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const method = 'DELETE';
      const requestPath = '/auth/api-key';

      // Create HMAC signature for L2 authentication
      const crypto = require('crypto');
      const message_to_sign = timestamp + method + requestPath + JSON.stringify({ key: apiKeyId });
      const signature = crypto
        .createHmac('sha256', apiSecret)
        .update(message_to_sign)
        .digest('base64');

      // Make HTTP request to delete API key
      const deleteResponse = await fetch(`${clobApiUrl}${requestPath}`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          POLY_ADDRESS: address,
          POLY_SIGNATURE: signature,
          POLY_TIMESTAMP: timestamp,
          POLY_API_KEY: apiKey,
          POLY_PASSPHRASE: apiPassphrase,
        },
        body: JSON.stringify({ key: apiKeyId }),
      });

      if (!deleteResponse.ok) {
        const errorText = await deleteResponse.text();
        throw new Error(
          `Failed to revoke API key: ${deleteResponse.status} ${deleteResponse.statusText}. ${errorText}`
        );
      }

      const deleteResult = await deleteResponse.json();

      logger.info('[revokeApiKeyAction] API key revoked successfully');

      // Format the response
      const responseData: RevokeApiKeyResponse = {
        success: true,
        apiKeyId: apiKeyId,
        revokedAt: new Date().toISOString(),
        message: 'API key revoked successfully',
      };

      // Create success message
      const successMessage = `✅ **API Key Revoked Successfully**

**Revocation Details:**
• **API Key ID**: \`${responseData.apiKeyId}\`
• **Revoked At**: ${responseData.revokedAt}
• **Status**: Permanently disabled

**⚠️ Important Notice:**
- This API key can no longer be used for authentication
- Any existing authenticated sessions using this key will be invalidated
- You'll need to create a new API key for future trading operations

**Next Steps:**
If you need API access, use the CREATE_API_KEY action to generate new credentials.`;

      // Call callback with success response
      if (callback) {
        callback({
          text: successMessage,
          action: 'POLYMARKET_DELETE_API_KEY',
          data: {
            success: true,
            revocation: responseData,
          },
        });
      }

      logger.info('[revokeApiKeyAction] API key revocation completed successfully');
    } catch (error) {
      logger.error('[revokeApiKeyAction] Error revoking API key:', error);

      const errorMessage = `❌ **API Key Revocation Failed**

**Error**: ${error instanceof Error ? error.message : 'Unknown error occurred'}

**Possible Causes:**
• API key ID not found or already revoked
• Network connectivity issues
• Invalid authentication credentials
• Polymarket API rate limiting

**Please check:**
• The API key ID is correct and exists
• Your authentication credentials are valid
• Network connection is stable
• Try again in a few moments`;

      if (callback) {
        callback({
          text: errorMessage,
          action: 'POLYMARKET_DELETE_API_KEY',
          data: {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
      }
    }
  },
};
