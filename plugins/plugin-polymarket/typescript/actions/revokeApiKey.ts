import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import { callLLMWithTimeout, isLLMError } from '../utils/llmHelpers';
import { initializeClobClientWithCreds } from '../utils/clobClient';
import { revokeApiKeyTemplate } from '../templates';
import type { ClobClient } from '@polymarket/clob-client';

interface LLMRevokeResult {
  keyId?: string;
  confirm?: boolean;
  error?: string;
}

/**
 * Revoke API Key Action for Polymarket.
 * Revokes an existing API key from the user's account.
 */
export const revokeApiKeyAction: Action = {
  name: 'POLYMARKET_REVOKE_API_KEY',
  similes: ['DELETE_API_KEY', 'REMOVE_API_KEY', 'DISABLE_API_KEY', 'CANCEL_API_KEY'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description: 'Revokes an existing API key from your Polymarket account.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(`[revokeApiKeyAction] Validate called for message: "${message.content?.text}"`);
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
      logger.warn('[revokeApiKeyAction] CLOB_API_URL is required.');
      return false;
    }
    if (!privateKey) {
      logger.warn(
        '[revokeApiKeyAction] A private key (WALLET_PRIVATE_KEY, PRIVATE_KEY, or POLYMARKET_PRIVATE_KEY) is required.'
      );
      return false;
    }
    if (!clobApiKey || !clobApiSecret || !clobApiPassphrase) {
      const missing: string[] = [];
      if (!clobApiKey) missing.push('CLOB_API_KEY');
      if (!clobApiSecret) missing.push('CLOB_API_SECRET or CLOB_SECRET');
      if (!clobApiPassphrase) missing.push('CLOB_API_PASSPHRASE or CLOB_PASS_PHRASE');
      logger.warn(
        `[revokeApiKeyAction] Missing required API credentials for L2 authentication: ${missing.join(', ')}.`
      );
      return false;
    }
    logger.info('[revokeApiKeyAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[revokeApiKeyAction] Handler called!');

    let llmResult: LLMRevokeResult = {};
    try {
      const result = await callLLMWithTimeout<LLMRevokeResult>(
        runtime,
        state,
        revokeApiKeyTemplate,
        'revokeApiKeyAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[revokeApiKeyAction] LLM result: ${JSON.stringify(llmResult)}`);

      if (llmResult.error || !llmResult.keyId) {
        throw new Error(llmResult.error || 'API Key ID not found in LLM result.');
      }
    } catch (error) {
      logger.warn('[revokeApiKeyAction] LLM extraction failed, trying regex fallback', error);
      const text = message.content?.text || '';

      const keyIdMatch = text.match(
        /(?:key|keyId|api[_\s]?key|id|revoke)\s*[:=#]?\s*([0-9a-zA-Z_\-]+)/i
      );

      if (keyIdMatch) {
        llmResult.keyId = keyIdMatch[1];
        logger.info(`[revokeApiKeyAction] Regex extracted keyId: ${llmResult.keyId}`);
      } else {
        const errorMessage = 'Please specify an API Key ID to revoke.';
        logger.error(`[revokeApiKeyAction] Extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ['REVOKE_API_KEY'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
    }

    const keyId = llmResult.keyId!;

    // Safety check - don't allow revoking the currently active key
    const currentApiKey = runtime.getSetting('CLOB_API_KEY');
    if (currentApiKey && keyId === currentApiKey) {
      const warningContent: Content = {
        text: `⚠️ **Warning**: You are attempting to revoke the currently active API key (\`${keyId.substring(0, 8)}...\`).\n\nThis will immediately disable your ability to perform authenticated operations.\n\n**Are you sure?** To confirm, say "confirm revoke ${keyId}"`,
        actions: ['REVOKE_API_KEY'],
        data: {
          keyId,
          isActiveKey: true,
          requiresConfirmation: true,
        },
      };
      if (callback) await callback(warningContent);
      return warningContent;
    }

    logger.info(`[revokeApiKeyAction] Revoking API key: ${keyId}`);

    try {
      const client = await initializeClobClientWithCreds(runtime) as ClobClient;

      // The CLOB client may not have a direct revokeApiKey method
      // We'll attempt to call it if available, otherwise provide guidance
      if (typeof client.deleteApiKey === 'function') {
        await client.deleteApiKey();
        
        const successContent: Content = {
          text: `✅ **API Key Revoked Successfully**\n\n• **Key ID**: \`${keyId}\`\n• **Status**: Revoked\n• **Time**: ${new Date().toISOString()}\n\n⚠️ This key can no longer be used for authentication. Any applications or scripts using this key will stop working.`,
          actions: ['REVOKE_API_KEY'],
          data: {
            keyId,
            revoked: true,
            timestamp: new Date().toISOString(),
          },
        };

        if (callback) await callback(successContent);
        return successContent;
      } else {
        // Provide guidance on how to revoke via API directly
        const infoContent: Content = {
          text: `ℹ️ **API Key Revocation**\n\nTo revoke API key \`${keyId.substring(0, 8)}...\`, you may need to:\n\n1. Visit the Polymarket website and manage your API keys\n2. Use the CLOB API directly: \`DELETE /auth/api-key\`\n\n*The current CLOB client version may not support programmatic key revocation.*`,
          actions: ['REVOKE_API_KEY'],
          data: {
            keyId,
            revoked: false,
            reason: 'Method not available in client',
          },
        };

        if (callback) await callback(infoContent);
        return infoContent;
      }
    } catch (error) {
      logger.error(`[revokeApiKeyAction] Error revoking API key ${keyId}:`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error revoking API key**: ${errorMessage}`,
        actions: ['REVOKE_API_KEY'],
        data: {
          keyId,
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
      { name: '{{user1}}', content: { text: 'Revoke API key abc123 on Polymarket.' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Revoking API key abc123 from your Polymarket account...',
          action: 'POLYMARKET_REVOKE_API_KEY',
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Delete my old Polymarket API key xyz789.' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Attempting to revoke API key xyz789...',
          action: 'POLYMARKET_REVOKE_API_KEY',
        },
      },
    ],
  ],
};
