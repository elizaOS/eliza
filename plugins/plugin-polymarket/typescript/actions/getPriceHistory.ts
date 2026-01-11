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
import { getPriceHistoryTemplate } from '../templates';
import type { ClobClient } from '@polymarket/clob-client';

interface LLMPriceHistoryResult {
  tokenId?: string;
  startTs?: number;
  endTs?: number;
  fidelity?: number;
  error?: string;
}

interface PriceHistoryPoint {
  t: number;
  p: string;
}

type PriceHistoryResponse = PriceHistoryPoint[];

/**
 * Get Price History Action for Polymarket.
 * Retrieves historical prices for a specific token over a time range.
 */
export const getPriceHistoryAction: Action = {
  name: 'POLYMARKET_GET_PRICE_HISTORY',
  similes: ['HISTORICAL_PRICES', 'PRICE_CHART', 'TOKEN_PRICE_HISTORY', 'PRICE_DATA'].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    'Retrieves historical prices for a specific token ID on Polymarket over a specified time range.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(`[getPriceHistoryAction] Validate called for message: "${message.content?.text}"`);
    const clobApiUrl = runtime.getSetting('CLOB_API_URL');

    if (!clobApiUrl) {
      logger.warn('[getPriceHistoryAction] CLOB_API_URL is required.');
      return false;
    }
    logger.info('[getPriceHistoryAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[getPriceHistoryAction] Handler called!');

    let llmResult: LLMPriceHistoryResult = {};
    try {
      const result = await callLLMWithTimeout<LLMPriceHistoryResult>(
        runtime,
        state,
        getPriceHistoryTemplate,
        'getPriceHistoryAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[getPriceHistoryAction] LLM result: ${JSON.stringify(llmResult)}`);

      if (llmResult.error || !llmResult.tokenId) {
        throw new Error(llmResult.error || 'Token ID not found in LLM result.');
      }
    } catch (error) {
      logger.warn('[getPriceHistoryAction] LLM extraction failed, trying regex fallback', error);
      const text = message.content?.text || '';

      const tokenIdMatch = text.match(
        /(?:token|tokenId|asset|id|history\s+for)\s*[:=#]?\s*([0-9a-zA-Z_\-]+)/i
      );

      if (tokenIdMatch) {
        llmResult.tokenId = tokenIdMatch[1];
        logger.info(
          `[getPriceHistoryAction] Regex extracted tokenId: ${llmResult.tokenId}`
        );
      } else {
        const errorMessage = 'Please specify a Token ID to get price history.';
        logger.error(`[getPriceHistoryAction] Extraction failed. Text: "${text}"`);
        const errorContent: Content = {
          text: `❌ **Error**: ${errorMessage}`,
          actions: ['GET_PRICE_HISTORY'],
          data: { error: errorMessage },
        };
        if (callback) await callback(errorContent);
        throw new Error(errorMessage);
      }
    }

    const tokenId = llmResult.tokenId!;
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - 86400; // Default to last 24 hours
    const startTs = llmResult.startTs || oneDayAgo;
    const endTs = llmResult.endTs || now;
    const fidelity = llmResult.fidelity || 60; // Default to 60-minute intervals

    logger.info(
      `[getPriceHistoryAction] Fetching price history for token: ${tokenId} from ${startTs} to ${endTs} with fidelity ${fidelity}`
    );

    try {
      const client = await initializeClobClient(runtime) as ClobClient;
      const priceHistory: PriceHistoryResponse = await client.getPricesHistory({
        tokenID: tokenId,
        startTs,
        endTs,
        fidelity,
      });

      let responseText = `📈 **Price History for Token ${tokenId}**:\n\n`;

      if (priceHistory && priceHistory.length > 0) {
        responseText += `Retrieved ${priceHistory.length} data point(s):\n\n`;

        // Show first and last few points
        const showCount = Math.min(5, priceHistory.length);
        const firstPoints = priceHistory.slice(0, showCount);
        const lastPoints =
          priceHistory.length > showCount * 2
            ? priceHistory.slice(-showCount)
            : [];

        responseText += `**First ${showCount} Points:**\n`;
        firstPoints.forEach((point: PriceHistoryPoint) => {
          const date = new Date(point.t * 1000).toLocaleString();
          responseText += `• ${date}: $${parseFloat(point.p).toFixed(4)}\n`;
        });

        if (lastPoints.length > 0) {
          responseText += `\n**Last ${showCount} Points:**\n`;
          lastPoints.forEach((point: PriceHistoryPoint) => {
            const date = new Date(point.t * 1000).toLocaleString();
            responseText += `• ${date}: $${parseFloat(point.p).toFixed(4)}\n`;
          });
        }

        if (priceHistory.length > showCount * 2) {
          responseText += `\n*... and ${priceHistory.length - showCount * 2} more data points.*\n`;
        }

        // Calculate price change
        const startPrice = parseFloat(priceHistory[0].p);
        const endPrice = parseFloat(priceHistory[priceHistory.length - 1].p);
        const priceChange = endPrice - startPrice;
        const priceChangePercent = ((priceChange / startPrice) * 100).toFixed(2);
        const changeEmoji = priceChange >= 0 ? '📈' : '📉';

        responseText += `\n**Summary:**\n`;
        responseText += `• Start Price: $${startPrice.toFixed(4)}\n`;
        responseText += `• End Price: $${endPrice.toFixed(4)}\n`;
        responseText += `• Change: ${changeEmoji} ${priceChange >= 0 ? '+' : ''}$${priceChange.toFixed(4)} (${priceChangePercent}%)\n`;
      } else {
        responseText += `No price history found for the specified time range.\n`;
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['GET_PRICE_HISTORY'],
        data: {
          tokenId,
          priceHistory,
          startTs,
          endTs,
          fidelity,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error(
        `[getPriceHistoryAction] Error getting price history for ${tokenId}:`,
        error
      );
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error getting price history**: ${errorMessage}`,
        actions: ['GET_PRICE_HISTORY'],
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
        content: { text: 'Show price history for token xyz123 on Polymarket.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Fetching price history for token xyz123 on Polymarket...',
          action: 'POLYMARKET_GET_PRICE_HISTORY',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Get the historical prices for token 0xabc789 over the last week via Polymarket.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Looking up historical prices for token 0xabc789 on Polymarket...',
          action: 'POLYMARKET_GET_PRICE_HISTORY',
        },
      },
    ],
  ],
};
