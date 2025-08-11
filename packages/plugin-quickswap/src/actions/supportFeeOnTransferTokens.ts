import { Action, IAgentRuntime, logger, Memory, composePromptFromState } from '@elizaos/core';
import { z } from 'zod';
import { callLLMWithTimeout } from '../utils/llmHelpers.js';
import { supportFeeOnTransferTokensTemplate } from '../templates/supportFeeOnTransferTokensTemplate.js';
import { initializeQuickswapClient } from '../utils/quickswapClient.js';

interface SupportFeeOnTransferTokensParams {
  tokenSymbolOrAddress: string;
}

/**
 * M5-11: Checks if a given token is a fee-on-transfer token and if Quickswap supports it.
 */
export const supportFeeOnTransferTokensAction: Action = {
  name: 'QUICKSWAP_SUPPORT_FEE_ON_TRANSFER_TOKENS',
  similes: [
    'CHECK_TOKEN_COMPATIBILITY',
    'IS_FEE_ON_TRANSFER',
    'FEE_TOKEN_CHECK',
    'TOKEN_SUPPORT',
  ].map((s) => `QUICKSWAP_${s}`),
  description:
    'Checks if a token is a fee-on-transfer token and if Quickswap can handle it for trades.',
  validate: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(
      `[supportFeeOnTransferTokensAction] Validate called for message: "${message.content?.text}"`
    );

    const quickswapApiUrl = runtime.getSetting('QUICKSWAP_API_URL');

    if (!quickswapApiUrl) {
      logger.warn(
        '[supportFeeOnTransferTokensAction] QUICKSWAP_API_URL is required but not provided'
      );
      return false;
    }

    return true;
  },
  handler: async (runtime: IAgentRuntime, message: Memory) => {
    logger.info(
      `[supportFeeOnTransferTokensAction] Handler called for message: "${message.content?.text}"`
    );

    let params: SupportFeeOnTransferTokensParams;

    try {
      const llmResult = await callLLMWithTimeout<
        SupportFeeOnTransferTokensParams & { error?: string }
      >(
        runtime,
        null,
        supportFeeOnTransferTokensTemplate,
        'supportFeeOnTransferTokensAction',
        message.content?.text || ''
      );

      logger.info('[supportFeeOnTransferTokensAction] LLM result:', JSON.stringify(llmResult));

      if (llmResult?.error || !llmResult?.tokenSymbolOrAddress) {
        throw new Error('Token symbol or address not found by LLM');
      }
      params = llmResult;
    } catch (error) {
      logger.warn(
        '[supportFeeOnTransferTokensAction] LLM extraction failed, trying regex fallback'
      );

      const text = message.content?.text || '';
      const tokenMatch = text.match(/(?:fee-on-transfer|support)\s+([a-zA-Z0-9]+)/i);

      if (tokenMatch && tokenMatch.length >= 2) {
        params = {
          tokenSymbolOrAddress: tokenMatch[1],
        };
      } else {
        const errorMessage =
          'Please specify the token symbol or address (e.g., "check support for XYZ token").';
        logger.error(`[supportFeeOnTransferTokensAction] Parameter extraction failed`);
        return {
          text: `❌ **Error**: ${errorMessage}\n\nExamples:\n• "Check if XYZ token is a fee-on-transfer token"
• "Does Quickswap support trading with token ABC?"

**Required parameters:**
- Token Symbol/Address`,
          actions: ['QUICKSWAP_SUPPORT_FEE_ON_TRANSFER_TOKENS'],
          data: { error: errorMessage },
        };
      }
    }

    try {
      const quickswapClient = await initializeQuickswapClient(runtime);
      const supportResult = await quickswapClient.checkFeeOnTransferTokenSupport(
        params.tokenSymbolOrAddress
      );

      if (supportResult && supportResult.isSupported) {
        const responseText = `✅ **Quickswap Support Check for ${params.tokenSymbolOrAddress.toUpperCase()}**\n\n• **Token**: ${params.tokenSymbolOrAddress.toUpperCase()}\n• **Is Fee-on-Transfer**: ${supportResult.isFeeOnTransfer ? 'Yes' : 'No'}\n• **Quickswap Supported**: Yes`;
        return {
          text: responseText,
          actions: ['QUICKSWAP_SUPPORT_FEE_ON_TRANSFER_TOKENS'],
          data: {
            success: true,
            token: params.tokenSymbolOrAddress,
            isFeeOnTransfer: supportResult.isFeeOnTransfer,
            isSupported: supportResult.isSupported,
            timestamp: new Date().toISOString(),
          },
        };
      } else if (supportResult && !supportResult.isSupported) {
        const responseText = `⚠️ **Quickswap Support Check for ${params.tokenSymbolOrAddress.toUpperCase()}**\n\n• **Token**: ${params.tokenSymbolOrAddress.toUpperCase()}\n• **Is Fee-on-Transfer**: ${supportResult.isFeeOnTransfer ? 'Yes' : 'No'}\n• **Quickswap Supported**: No - ${supportResult.error || 'Reason unknown'}`;
        return {
          text: responseText,
          actions: ['QUICKSWAP_SUPPORT_FEE_ON_TRANSFER_TOKENS'],
          data: {
            success: false,
            token: params.tokenSymbolOrAddress,
            isFeeOnTransfer: supportResult.isFeeOnTransfer,
            isSupported: supportResult.isSupported,
            error: supportResult.error,
            timestamp: new Date().toISOString(),
          },
        };
      } else {
        const errorMessage = 'Failed to determine fee-on-transfer support.';
        return {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ['QUICKSWAP_SUPPORT_FEE_ON_TRANSFER_TOKENS'],
          data: {
            success: false,
            error: errorMessage,
            params,
            timestamp: new Date().toISOString(),
          },
        };
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Unknown error occurred while checking token support';
      logger.error(`[supportFeeOnTransferTokensAction] Error checking token support:`, error);

      return {
        text: `❌ **Error**: ${errorMessage}\n\nPlease check your configuration and try again.`,
        actions: ['QUICKSWAP_SUPPORT_FEE_ON_TRANSFER_TOKENS'],
        data: {
          error: errorMessage,
          params,
          timestamp: new Date().toISOString(),
        },
      };
    }
  },
  examples: [
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Check if the token XYZ is a fee-on-transfer token via Quickswap',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Checking token support via Quickswap...',
          action: 'QUICKSWAP_SUPPORT_FEE_ON_TRANSFER_TOKENS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Does Quickswap support trading with ABC token?',
        },
      },
      {
        name: '{{user2}} ',
        content: {
          text: 'Checking token support via Quickswap...',
          action: 'QUICKSWAP_SUPPORT_FEE_ON_TRANSFER_TOKENS',
        },
      },
    ],
  ],
};
