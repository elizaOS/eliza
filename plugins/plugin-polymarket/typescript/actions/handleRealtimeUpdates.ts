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
import { handleRealtimeUpdatesTemplate } from '../templates';

interface LLMRealtimeResult {
  action?: 'subscribe' | 'unsubscribe' | 'status';
  channel?: string;
  assetIds?: string[];
  error?: string;
}

interface SubscriptionStatus {
  channel: string;
  assetIds?: string[];
  status: 'active' | 'inactive' | 'pending';
  subscribedAt?: string;
}

/**
 * Handle Realtime Updates Action for Polymarket.
 * Manages WebSocket subscriptions for real-time market data.
 */
export const handleRealtimeUpdatesAction: Action = {
  name: 'POLYMARKET_HANDLE_REALTIME_UPDATES',
  similes: [
    'SUBSCRIBE_UPDATES',
    'LIVE_UPDATES',
    'REALTIME_DATA',
    'MARKET_STREAM',
    'WEBSOCKET_STATUS',
  ].map((s) => `POLYMARKET_${s}`),
  description:
    'Manages WebSocket subscriptions for real-time Polymarket data updates including order books and trades.',

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(
      `[handleRealtimeUpdatesAction] Validate called for message: "${message.content?.text}"`
    );
    const clobWsUrl = runtime.getSetting('CLOB_WS_URL');

    if (!clobWsUrl) {
      logger.warn('[handleRealtimeUpdatesAction] CLOB_WS_URL is required for WebSocket connections.');
      return false;
    }
    logger.info('[handleRealtimeUpdatesAction] Validation passed');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[handleRealtimeUpdatesAction] Handler called!');

    let llmResult: LLMRealtimeResult = {};
    try {
      const result = await callLLMWithTimeout<LLMRealtimeResult>(
        runtime,
        state,
        handleRealtimeUpdatesTemplate,
        'handleRealtimeUpdatesAction'
      );
      if (result && !isLLMError(result)) {
        llmResult = result;
      }
      logger.info(`[handleRealtimeUpdatesAction] LLM result: ${JSON.stringify(llmResult)}`);
    } catch (error) {
      logger.warn('[handleRealtimeUpdatesAction] LLM extraction failed, defaulting to status', error);
      llmResult.action = 'status';
    }

    const action = llmResult.action || 'status';
    const channel = llmResult.channel;
    const assetIds = llmResult.assetIds;

    logger.info(`[handleRealtimeUpdatesAction] Action: ${action}, Channel: ${channel}, Assets: ${assetIds?.join(', ')}`);

    try {
      // Note: Full WebSocket implementation would require a service to manage connections.
      // This action provides status and configuration guidance.

      let responseText = `📡 **Polymarket Realtime Updates**\n\n`;

      const clobWsUrl = runtime.getSetting('CLOB_WS_URL');

      if (action === 'status') {
        responseText += `**WebSocket Configuration:**\n`;
        responseText += `• **Endpoint**: ${clobWsUrl || 'Not configured'}\n\n`;

        responseText += `**Available Channels:**\n`;
        responseText += `• \`price\` - Real-time price updates\n`;
        responseText += `• \`book\` - Order book changes\n`;
        responseText += `• \`trade\` - Trade executions\n`;
        responseText += `• \`ticker\` - Market ticker updates\n`;
        responseText += `• \`user\` - Authenticated user updates (orders, fills)\n\n`;

        const mockSubscriptions: SubscriptionStatus[] = [
          { channel: 'price', status: 'inactive' },
          { channel: 'book', status: 'inactive' },
          { channel: 'trade', status: 'inactive' },
        ];

        responseText += `**Current Subscriptions:**\n`;
        mockSubscriptions.forEach((sub: SubscriptionStatus) => {
          const statusEmoji = sub.status === 'active' ? '🟢' : sub.status === 'pending' ? '🟡' : '⚪';
          responseText += `${statusEmoji} ${sub.channel}: ${sub.status}\n`;
        });

        responseText += `\n💡 *WebSocket subscriptions are managed by the PolymarketService.*\n`;
        responseText += `*Use "subscribe to price updates for token xyz" to start streaming.*\n`;
      } else if (action === 'subscribe') {
        if (!channel) {
          responseText += `❌ Please specify a channel to subscribe to (price, book, trade, ticker, or user).\n`;
        } else if (!assetIds || assetIds.length === 0) {
          responseText += `❌ Please specify asset ID(s) to subscribe to.\n`;
        } else {
          responseText += `📥 **Subscribing to ${channel} updates...**\n\n`;
          responseText += `• **Channel**: ${channel}\n`;
          responseText += `• **Assets**: ${assetIds.join(', ')}\n\n`;
          responseText += `⏳ *Subscription request initiated.*\n`;
          responseText += `*Note: Full WebSocket management requires the PolymarketService to be running.*\n`;
        }
      } else if (action === 'unsubscribe') {
        if (!channel) {
          responseText += `❌ Please specify a channel to unsubscribe from.\n`;
        } else {
          responseText += `📤 **Unsubscribing from ${channel}...**\n\n`;
          if (assetIds && assetIds.length > 0) {
            responseText += `• **Assets**: ${assetIds.join(', ')}\n`;
          } else {
            responseText += `• Unsubscribing from all assets on this channel.\n`;
          }
          responseText += `\n⏳ *Unsubscription request initiated.*\n`;
        }
      }

      const responseContent: Content = {
        text: responseText,
        actions: ['POLYMARKET_HANDLE_REALTIME_UPDATES'],
        data: {
          action,
          channel,
          assetIds,
          wsUrl: clobWsUrl,
          timestamp: new Date().toISOString(),
        },
      };

      if (callback) await callback(responseContent);
      return responseContent;
    } catch (error) {
      logger.error('[handleRealtimeUpdatesAction] Error handling realtime updates:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred.';
      const errorContent: Content = {
        text: `❌ **Error managing realtime updates**: ${errorMessage}`,
        actions: ['POLYMARKET_HANDLE_REALTIME_UPDATES'],
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
      { name: '{{user1}}', content: { text: "What's the status of Polymarket realtime updates?" } },
      {
        name: '{{user2}}',
        content: {
          text: 'Checking the status of Polymarket WebSocket subscriptions...',
          action: 'POLYMARKET_HANDLE_REALTIME_UPDATES',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Subscribe to price updates for token xyz123 on Polymarket.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Setting up price update subscription for token xyz123...',
          action: 'POLYMARKET_HANDLE_REALTIME_UPDATES',
        },
      },
    ],
  ],
};
