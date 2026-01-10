import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { callLLMWithTimeout } from '../utils/llmHelpers';
import { initializeClobClientWithCreds } from '../utils/clobClient';
import type { ClobClient } from '@polymarket/clob-client';
import { getAccountAccessStatusTemplate } from '../templates';
import type { ApiKeysResponse, ApiKey } from '../types';

/**
 * Get account access status, including U.S. certification requirements and API key details.
 */
export const getAccountAccessStatusAction: Action = {
  name: 'POLYMARKET_GET_ACCOUNT_ACCESS_STATUS',
  similes: [
    'ACCOUNT_CERTIFICATION_STATUS',
    'CHECK_MY_POLYMARKET_ACCESS',
    'POLYMARKET_CERT_REQUIRED',
    'MY_API_KEYS_STATUS',
    'USER_ACCESS_INFO',
  ],
  description:
    'Retrieves account access status from Polymarket, including U.S. certification requirements and API key details.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(
      `[getAccountAccessStatusAction] Validate called for message: "${message.content?.text}"`
    );
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');
    const privateKey =
      runtime.getSetting('WALLET_PRIVATE_KEY') ||
      runtime.getSetting('PRIVATE_KEY') ||
      runtime.getSetting('POLYMARKET_PRIVATE_KEY');

    if (!clobApiUrl) {
      logger.warn('[getAccountAccessStatusAction] CLOB_API_URL is required');
      return false;
    }
    if (!privateKey) {
      logger.warn(
        '[getAccountAccessStatusAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required to attempt U.S. certification status check.'
      );
    }
    logger.info('[getAccountAccessStatusAction] Validation passed (basic checks)');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getAccountAccessStatusAction] Handler called!');

    try {
      const llmResult = await callLLMWithTimeout<{ error?: string }>(
        runtime,
        state,
        getAccountAccessStatusTemplate,
        'getAccountAccessStatusAction'
      );
      if (llmResult?.error) {
        logger.warn(
          `[getAccountAccessStatusAction] LLM indicated potential misinterpretation: ${llmResult.error}`
        );
      }
    } catch (error) {
      logger.warn(
        '[getAccountAccessStatusAction] LLM call failed or timed out, proceeding with action anyway:',
        error
      );
    }

    try {
      let certRequired: boolean | undefined = undefined;
      let apiKeysList: ApiKey[] = [];
      let apiKeysError: string | undefined = undefined;

      const clobApiKey = runtime.getSetting('CLOB_API_KEY');
      const clobApiSecret =
        runtime.getSetting('CLOB_API_SECRET') || runtime.getSetting('CLOB_SECRET');
      const clobApiPassphrase =
        runtime.getSetting('CLOB_API_PASSPHRASE') || runtime.getSetting('CLOB_PASS_PHRASE');
      const hasConfiguredManagedApiCredentials = clobApiKey && clobApiSecret && clobApiPassphrase;

      // Check for a session/derived key explicitly set by createApiKeyAction or handleAuthenticationAction
      // These might be different from the .env configured ones used for getApiKeys()
      const sessionApiKeyId = runtime.getSetting('POLYMARKET_SESSION_API_KEY_ID');
      const sessionApiLabel = runtime.getSetting('POLYMARKET_SESSION_API_LABEL');
      const sessionApiSource = runtime.getSetting('POLYMARKET_SESSION_API_SOURCE'); // e.g., 'derived', 'user-provided'

      if (hasConfiguredManagedApiCredentials) {
        try {
          logger.info(
            '[getAccountAccessStatusAction] Configured API credentials found. Attempting to fetch managed API keys and cert status.'
          );
          const client = (await initializeClobClientWithCreds(runtime)) as ClobClient;
          const officialResponse: any = await client.getApiKeys();
          const accessStatus: ApiKeysResponse = officialResponse as ApiKeysResponse;
          certRequired = accessStatus.cert_required;
          apiKeysList = accessStatus.api_keys || [];
        } catch (err) {
          logger.error(
            '[getAccountAccessStatusAction] Error fetching API keys with credentials:',
            err
          );
          apiKeysError = err instanceof Error ? err.message : 'Failed to retrieve API keys.';
        }
      } else {
        logger.info(
          '[getAccountAccessStatusAction] Configured API credentials for managed key listing not found. Managed API key listing will be skipped. U.S. cert status might be unavailable.'
        );
        apiKeysError =
          'API credentials (CLOB_API_KEY, etc.) for listing managed keys are not configured in .env settings.';
      }

      let responseText = `🔑 **Polymarket Account Access Status**\n\n`;

      if (certRequired === undefined && hasConfiguredManagedApiCredentials && apiKeysError) {
        responseText += `**U.S. Certification Required**: ❓ Unknown (Error fetching status: ${apiKeysError})\n`;
      } else if (certRequired === undefined && !hasConfiguredManagedApiCredentials) {
        responseText += `**U.S. Certification Required**: ❓ Unknown (Managed API credentials not set to check status via getApiKeys)\n`;
      } else {
        responseText += `**U.S. Certification Required**: ${certRequired ? '✅ Yes' : '❌ No'}\n`;
        if (certRequired) {
          responseText += `   *This means your account may have restrictions on trading certain markets until certified.*\n`;
        }
      }

      responseText += `\n**Managed API Keys (from Polymarket account):**\n`;

      if (hasConfiguredManagedApiCredentials) {
        if (apiKeysError && !apiKeysList?.length) {
          responseText += `Could not retrieve managed API keys. Error: ${apiKeysError}\n`;
        } else if (apiKeysList && apiKeysList.length > 0) {
          responseText += `Found ${apiKeysList.length} managed key(s):\n`;
          apiKeysList.forEach((key: ApiKey) => {
            responseText += `• **Label**: ${key.label || 'N/A'} (ID: ${key.key_id?.substring(0, 8) || 'N/A'}...)\n`;
            responseText += `  ◦ **Type**: ${key.type || 'N/A'}\n`;
            responseText += `  ◦ **Status**: ${key.status || 'N/A'}\n`;
            responseText += `  ◦ **Created**: ${key.created_at ? new Date(key.created_at).toLocaleDateString() : 'N/A'}\n`;
            responseText += `  ◦ **Last Used**: ${key.last_used_at ? new Date(key.last_used_at).toLocaleDateString() : 'Never'}\n`;
            responseText += `  ◦ **Cert Whitelisted**: ${key.is_cert_whitelisted ? 'Yes' : 'No'}\n`;
          });
        } else {
          responseText += `No managed API keys found for your account.\n`;
        }
      } else {
        responseText += `Managed API key listing skipped as credentials for this are not configured (CLOB_API_KEY, etc. in .env).\n`;
      }

      // Add information about any active session/derived key
      responseText += `\n**Active Session API Key:**\n`;
      if (sessionApiKeyId) {
        responseText += `• **ID**: \`${sessionApiKeyId.substring(0, 8)}...\`\n`;
        if (sessionApiLabel) {
          responseText += `• **Label/Source**: ${sessionApiLabel} (${sessionApiSource || 'runtime'})\n`;
        }
        responseText += `  *This key is active for the current session but may not be a long-term managed key on your Polymarket account.*\n`;
      } else {
        responseText += `No specific API key is currently active for this session (beyond any .env configured managed keys).\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_ACCOUNT_ACCESS_STATUS'],
        data: {
          certRequired,
          managedApiKeys: apiKeysList, // Renamed for clarity
          activeSessionKey: sessionApiKeyId
            ? { id: sessionApiKeyId, label: sessionApiLabel, source: sessionApiSource }
            : undefined,
          error: apiKeysError,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[getAccountAccessStatusAction] Error fetching account access status:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';

      const errorContent: Content = {
        text: `❌ **Error**: ${errorMessage}`,
        actions: ['POLYMARKET_GET_ACCOUNT_ACCESS_STATUS'],
        data: { error: errorMessage, timestamp: new Date().toISOString() },
      };

      if (callback) await callback(errorContent);
      throw error;
    }
  },

  examples: [
    [
      { name: '{{user1}}', content: { text: 'What is my Polymarket account access status?' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Okay, checking your Polymarket account access status...',
          action: 'POLYMARKET_GET_ACCOUNT_ACCESS_STATUS',
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Do I need U.S. certification for Polymarket?' } },
      {
        name: '{{user2}}',
        content: {
          text: "Let me check your account's U.S. certification requirement...",
          action: 'POLYMARKET_GET_ACCOUNT_ACCESS_STATUS',
        },
      },
    ],
  ],
};
