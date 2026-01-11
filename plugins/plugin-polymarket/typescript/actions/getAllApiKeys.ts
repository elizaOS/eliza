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
import { getAllApiKeysTemplate } from '../templates';
import type { ApiKeysResponse, ApiKey } from '../types';

interface LLMApiKeysResult {
  error?: string;
}

/**
 * Get All API Keys Action for Polymarket.
 * Retrieves all API keys associated with the authenticated user's account.
 */
export const getAllApiKeysAction: Action = {
  name: 'POLYMARKET_GET_ALL_API_KEYS',
  similes: ['LIST_MY_API_KEYS', 'VIEW_API_CREDENTIALS', 'SHOW_ALL_KEYS', 'MY_CLOB_KEYS'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Retrieves all API keys associated with the authenticated user Polymarket account.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(`[getAllApiKeysAction] Validate called for message: "${message.content?.text}"`);
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');
    const clobApiKey = runtime.getSetting('CLOB_API_KEY');
    const clobApiSecret =
      runtime.getSetting('CLOB_API_SECRET') || runtime.getSetting('CLOB_SECRET');
    const clobApiPassphrase =
      runtime.getSetting('CLOB_API_PASSPHRASE') || runtime.getSetting('CLOB_PASS_PHRASE');
    const privateKey =
      runtime.getSetting('WALLET_PRIVATE_KEY') ||
      runtime.getSetting('PRIVATE_KEY') ||
      runtime.getSetting('POLYMARKET_PRIVATE_KEY');

    if (!clobApiUrl) {
      logger.warn('[getAllApiKeysAction] CLOB_API_URL is required.');
      return false;
    }
    if (!privateKey) {
      logger.warn(
        '[getAllApiKeysAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.'
      );
      return false;
    }
    if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
      const missing: string[] = [];
      if (!clobApiKey) missing.push('CLOB_API_KEY');
      if (!clobApiSecret) missing.push('CLOB_API_SECRET or CLOB_SECRET');
      if (!clobApiPassphrase) missing.push('CLOB_API_PASSPHRASE or CLOB_PASS_PHRASE');
      logger.warn(
        `[getAllApiKeysAction] Missing required API credentials for L2 authentication: ${missing.join(', ')}.`
      );
      return false;
    }
    logger.info('[getAllApiKeysAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getAllApiKeysAction] Handler called!');

    try {
      const llmResult = await callLLMWithTimeout<LLMApiKeysResult>(
        runtime,
        state,
        getAllApiKeysTemplate,
        'getAllApiKeysAction'
      );
      if (llmResult?.error) {
        logger.warn(`[getAllApiKeysAction] LLM indicated: ${llmResult.error}`);
      }
    } catch (error) {
      logger.warn('[getAllApiKeysAction] LLM call failed, proceeding anyway', error);
    }

    try {
      const client = await initializeClobClientWithCreds(runtime) as ClobClient;
      const response = await client.getApiKeys();
      const apiKeysResponse = response as ApiKeysResponse;
      const keys: ApiKey[] = apiKeysResponse.api_keys || [];

      let responseText = `🔑 **Your Polymarket API Keys:**\n\n`;

      if (keys && keys.length > 0) {
        responseText += `Found ${keys.length} API key(s):\n\n`;
        keys.forEach((key: ApiKey, index: number) => {
          responseText += `**${index + 1}. ${key.label || 'Unnamed Key'}**\n`;
          responseText += `   • **ID**: \`${key.key_id?.substring(0, 8) || 'N/A'}...\`\n`;
          responseText += `   • **Type**: ${key.type || 'N/A'}\n`;
          responseText += `   • **Status**: ${key.status || 'N/A'}\n`;
          responseText += `   • **Created**: ${key.created_at ? new Date(key.created_at).toLocaleString() : 'N/A'}\n`;
          responseText += `   • **Last Used**: ${key.last_used_at ? new Date(key.last_used_at).toLocaleString() : 'Never'}\n`;
          responseText += `   • **Cert Whitelisted**: ${key.is_cert_whitelisted ? '✅ Yes' : '❌ No'}\n`;
          responseText += `\n`;
        });
      } else {
        responseText += `You have no API keys registered.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_GET_ALL_API_KEYS'],
        data: {
          apiKeys: keys,
          cert_required: apiKeysResponse.cert_required,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[getAllApiKeysAction] Error fetching API keys:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';

      const errorContent: Content = {
        text: `❌ **Error fetching API keys**: ${errorMessage}`,
        actions: ['POLYMARKET_GET_ALL_API_KEYS'],
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
      { name: '{{user1}}', content: { text: 'List all my Polymarket API keys.' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching your Polymarket API keys...',
          action: 'POLYMARKET_GET_ALL_API_KEYS',
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Show my CLOB API credentials via Polymarket.' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Retrieving your API credentials from Polymarket...',
          action: 'POLYMARKET_GET_ALL_API_KEYS',
        },
      },
    ],
  ],
};
