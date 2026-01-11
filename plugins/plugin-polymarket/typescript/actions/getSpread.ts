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
import { initializeClobClient } from '../utils/clobClient';
import { getSpreadTemplate } from '../templates';
import type { ClobClient } from '@polymarket/clob-client';

interface LLMSpreadResult {
  tokenId?: string;
  error?: string;
}

interface SpreadResult {
  spread: string;
}

/**
 * Get Spread Action for Polymarket.
 * Returns the bid-ask spread for a given token.
 */
export const getSpreadAction: Action = {
  name: 'POLYMARKET_GET_SPREAD',
  similes: ['BID_ASK_SPREAD', 'MARKET_SPREAD', 'SPREAD_INFO', 'TOKEN_SPREAD'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Gets the bid-ask spread for a specified token ID on Polymarket.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(`[getSpreadAction] Validate called for message: "${message.content?.text}"`);
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getSpreadAction] CLOB_API_URL is required.');
      return false;
    }
    logger.info('[getSpreadAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getSpreadAction] Handler called!');

    let llmResult: LLMSpreadResult = {};
    try {
      const result = await callLLMWithTimeout<LLMSpreadResult>(
        runtime,
        state,
        getSpreadTemplate,
        'getSpreadAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[getSpreadAction] LLM result: ${JSON.stringify(llmResult)}`);

      if (llmResult.error || !llmResult.tokenId) {
        throw new Error(llmResult.error || 'Token ID not found in LLM result.');
      }
    } catch (error) {
      logger.warn('[getSpreadAction] LLM extraction failed, trying regex fallback', error);
      const text = message.content?.text || '';

      const tokenIdMatch = text.match(
        /(?:token|tokenId|asset|id|spread\s+for)\s*[:=#]?\s*([0-9a-zA-Z_\-]+)/i
      );

      if (tokenIdMatch) {
        llmResult.tokenId = tokenIdMatch[1];
        logger.info(`[getSpreadAction] Regex extracted tokenId: ${llmResult.tokenId}`);
      } else {
        const errorMessage = 'Please specify a Token ID to get the spread.';
        logger.error(`[getSpreadAction] Extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ['GET_SPREAD'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
    }

    const tokenId = llmResult.tokenId!;

    logger.info(`[getSpreadAction] Fetching spread for token: ${tokenId}`);

    try {
      const client = await initializeClobClient(runtime) as ClobClient;
      const spreadResult: SpreadResult = await client.getSpread(tokenId);

      let responseText = `📊 **Bid-Ask Spread for Token ${tokenId}**:\n\n`;
      if (spreadResult?.spread) {
        const spreadValue = parseFloat(spreadResult.spread);
        const spreadPercent = (spreadValue * 100).toFixed(2);
        responseText += `• **Spread**: $${spreadValue.toFixed(4)} (${spreadPercent}%)\n`;
        responseText += `\n*A tighter spread indicates better liquidity and lower trading costs.*\n`;
      } else {
        responseText += `Could not retrieve spread. The order book may be empty or have insufficient quotes.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['GET_SPREAD'],
        data: {
          tokenId,
          spread: spreadResult?.spread,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error(`[getSpreadAction] Error getting spread for ${tokenId}:`, error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error getting spread**: ${errorMessage}`,
        actions: ['GET_SPREAD'],
        data: {
          tokenId,
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
      {
        name: '{{user1}}',
        content: { text: 'What is the spread for token xyz123 on Polymarket?' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching the bid-ask spread for token xyz123 on Polymarket...',
          action: 'POLYMARKET_GET_SPREAD',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Get the market spread for token 0xabc789 via Polymarket.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Looking up the spread for token 0xabc789 on Polymarket...',
          action: 'POLYMARKET_GET_SPREAD',
        },
      },
    ],
  ],
};
