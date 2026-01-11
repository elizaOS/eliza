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
import { getMidpointPriceTemplate } from '../templates';
import type { ClobClient } from '@polymarket/clob-client';

interface LLMMidpointResult {
  tokenId?: string;
  error?: string;
}

interface MidpointResult {
  mid: string;
}

/**
 * Get Midpoint Price Action for Polymarket.
 * Returns the midpoint price (average of best bid and best ask) for a given token.
 */
export const getMidpointPriceAction: Action = {
  name: 'POLYMARKET_GET_MIDPOINT_PRICE',
  similes: ['GET_MID_PRICE', 'MIDPOINT', 'MID_MARKET', 'FAIR_VALUE_PRICE'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Gets the midpoint price (average of best bid and best ask) for a specified token ID on Polymarket.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(
      `[getMidpointPriceAction] Validate called for message: "${message.content?.text}"`
    );
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getMidpointPriceAction] CLOB_API_URL is required.');
      return false;
    }
    logger.info('[getMidpointPriceAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getMidpointPriceAction] Handler called!');

    let llmResult: LLMMidpointResult = {};
    try {
      const result = await callLLMWithTimeout<LLMMidpointResult>(
        runtime,
        state,
        getMidpointPriceTemplate,
        'getMidpointPriceAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[getMidpointPriceAction] LLM result: ${JSON.stringify(llmResult)}`);

      if (llmResult.error || !llmResult.tokenId) {
        throw new Error(llmResult.error || 'Token ID not found in LLM result.');
      }
    } catch (error) {
      logger.warn('[getMidpointPriceAction] LLM extraction failed, trying regex fallback', error);
      const text = message.content?.text || '';

      const tokenIdMatch = text.match(
        /(?:token|tokenId|asset|id|for|midpoint\s+(?:price\s+)?(?:for|of))\s*[:=#]?\s*([0-9a-zA-Z_\-]+)/i
      );

      if (tokenIdMatch) {
        llmResult.tokenId = tokenIdMatch[1];
        logger.info(
          `[getMidpointPriceAction] Regex extracted tokenId: ${llmResult.tokenId}`
        );
      } else {
        const errorMessage = 'Please specify a Token ID to get the midpoint price.';
        logger.error(`[getMidpointPriceAction] Extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ['GET_MIDPOINT_PRICE'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
    }

    const tokenId = llmResult.tokenId!;

    logger.info(`[getMidpointPriceAction] Fetching midpoint price for token: ${tokenId}`);

    try {
      const client = await initializeClobClient(runtime) as ClobClient;
      const midpointResult: MidpointResult = await client.getMidpoint(tokenId);

      let responseText = `📈 **Midpoint Price for Token ${tokenId}**:\n\n`;
      if (midpointResult?.mid) {
        responseText += `• **Midpoint**: $${parseFloat(midpointResult.mid).toFixed(4)}\n`;
        responseText += `\n*The midpoint is the average of the best bid and best ask prices.*\n`;
      } else {
        responseText += `Could not retrieve midpoint price. Order book might be empty or have no quotes on both sides.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['GET_MIDPOINT_PRICE'],
        data: {
          tokenId,
          midpoint: midpointResult?.mid,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error(
        `[getMidpointPriceAction] Error getting midpoint price for ${tokenId}:`,
        error
      );
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error getting midpoint price**: ${errorMessage}`,
        actions: ['GET_MIDPOINT_PRICE'],
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
        content: { text: 'What is the midpoint price for token xyz123 on Polymarket?' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching the midpoint price for token xyz123 on Polymarket...',
          action: 'POLYMARKET_GET_MIDPOINT_PRICE',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Get the mid-market price for token 0xabc789 via Polymarket.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Looking up the midpoint price for token 0xabc789 on Polymarket...',
          action: 'POLYMARKET_GET_MIDPOINT_PRICE',
        },
      },
    ],
  ],
};
