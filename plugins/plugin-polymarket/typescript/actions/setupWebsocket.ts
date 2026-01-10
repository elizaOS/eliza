import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import WebSocket from 'ws'; // Import WebSocket from 'ws'
import { callLLMWithTimeout } from '../utils/llmHelpers';
import { setupWebsocketTemplate } from '../templates';
import {
  setActiveClobSocketClientReference,
  getActiveWebSocketClient,
} from './handleRealtimeUpdates'; // Adjusted for ws.WebSocket type

// Interface for WebSocket subscription message, based on socketExample.ts
interface SubscriptionMessage {
  auth?: { apiKey: string; secret: string; passphrase: string };
  type: 'user' | 'market'; // Restrict to known types
  markets?: string[];
  assets_ids?: string[];
  initial_dump?: boolean;
}

interface SetupWebsocketParams {
  markets?: string[]; // Condition IDs for market subscriptions
  userId?: string; // User's wallet address for user-specific channels
  error?: string; // From LLM
}

export const setupWebsocketAction: Action = {
  name: 'POLYMARKET_SETUP_WEBSOCKET',
  similes: [
    'CONNECT_POLYMARKET_WEBSOCKET',
    'SUBSCRIBE_MARKET_UPDATES',
    'LISTEN_TO_USER_TRADES',
    'REALTIME_POLYMARKET_FEED',
  ],
  description:
    'Establishes a WebSocket connection to Polymarket using the ws library and subscribes to specified market and/or user channels for real-time updates.',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info(`[setupWebsocketAction] Validate called.`);
    const clobWsUrl =
      runtime.getSetting('CLOB_WS_URL') || 'wss://ws-subscriptions-clob.polymarket.com/ws'; // Note: /ws path segment might be added later
    if (!clobWsUrl) {
      logger.warn(
        '[setupWebsocketAction] CLOB_WS_URL is required in settings for WebSocket connections.'
      );
      return false;
    }
    // Basic validation for private key / API creds will depend on params, checked in handler.
    logger.info('[setupWebsocketAction] CLOB_WS_URL found. Further validation in handler.');
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[setupWebsocketAction] Handler called - now using ws library.');

    // Clear any existing client from previous attempts / other types
    const existingClient = getActiveWebSocketClient();
    if (existingClient && typeof existingClient.terminate === 'function') {
      logger.info(
        '[setupWebsocketAction] Terminating existing WebSocket client before creating a new one.'
      );
      try {
        existingClient.terminate();
      } catch (e) {
        logger.warn('[setupWebsocketAction] Error terminating existing client, proceeding.', e);
      }
    }
    setActiveClobSocketClientReference(null);

    let extractedMarkets: string[] | undefined;
    let extractedUserId: string | undefined;

    try {
      logger.info('[setupWebsocketAction] Attempting LLM parameter extraction...');
      const extractedParams = await callLLMWithTimeout<SetupWebsocketParams>(
        runtime,
        state,
        setupWebsocketTemplate,
        'setupWebsocketAction'
      );
      logger.info(`[setupWebsocketAction] LLM raw parameters: ${JSON.stringify(extractedParams)}`);

      if (
        extractedParams.error &&
        (!extractedParams.markets || extractedParams.markets.length === 0) &&
        !extractedParams.userId
      ) {
        logger.warn(
          `[setupWebsocketAction] LLM indicated an issue and did not find parameters: ${extractedParams.error}. Triggering regex fallback.`
        );
        throw new Error('LLM failed to find parameters, trying regex.');
      }
      extractedMarkets = extractedParams.markets;
      extractedUserId = extractedParams.userId;
      if (extractedMarkets || extractedUserId) {
        logger.info(
          `[setupWebsocketAction] Parameters extracted by LLM: markets=${JSON.stringify(extractedMarkets)}, userId=${extractedUserId}`
        );
      } else {
        logger.info(
          '[setupWebsocketAction] LLM did not find any markets or userId, proceeding to regex fallback.'
        );
        throw new Error('LLM did not return markets or userId, trying regex.');
      }
    } catch (error: any) {
      logger.warn(
        `[setupWebsocketAction] LLM extraction failed or did not yield parameters (Error: ${error.message}). Attempting regex/manual extraction.`
      );
      const text = message.content?.text || '';
      const marketRegex =
        /market(?:s)?(?:\\s*[:\\-]?\\s*)((?:0x)?[0-9a-fA-F]{40,}|[a-zA-Z0-9_.-]+condition-[0-9]+)/gi;
      const marketMatches = Array.from(text.matchAll(marketRegex));
      if (marketMatches.length > 0) {
        extractedMarkets = marketMatches.map((m) => m[1]);
        logger.info(
          `[setupWebsocketAction] Regex fallback extracted markets: ${JSON.stringify(extractedMarkets)}`
        );
      }
      const userRegex = /user(?:Id)?(?:\\s*[:\\-]?\\s*)((?:0x)?[0-9a-fA-F]{40})/i;
      const userMatch = text.match(userRegex);
      if (userMatch && userMatch[1]) {
        extractedUserId = userMatch[1];
        logger.info(`[setupWebsocketAction] Regex fallback extracted userId: ${extractedUserId}`);
      }
    }

    if ((!extractedMarkets || extractedMarkets.length === 0) && !extractedUserId) {
      const errorMsg =
        'Please specify at least one market (condition ID) or a userId for user-specific updates. Neither LLM nor regex could extract them.';
      logger.warn(
        `[setupWebsocketAction] Validation Failure: ${errorMsg} Input was: "${message.content?.text}"`
      );
      if (callback) await callback({ text: `❌ ${errorMsg}` });
      throw new Error(errorMsg);
    }

    // Determine subscription type and construct WebSocket URL
    const baseWsUrl =
      runtime.getSetting('CLOB_WS_URL') || 'wss://ws-subscriptions-clob.polymarket.com/ws'; // Ensure /ws is part of base or added
    const subscriptionType: 'user' | 'market' = extractedUserId ? 'user' : 'market'; // Prefer user if userId is present
    const wsUrl = `${baseWsUrl.endsWith('/ws') ? baseWsUrl : baseWsUrl + '/ws'}/${subscriptionType}`;
    logger.info(`[setupWebsocketAction] Constructed WebSocket URL: ${wsUrl}`);

    // Prepare subscription message payload
    const subMsgPayload: SubscriptionMessage = {
      type: subscriptionType,
      initial_dump: true, // As per example
    };

    if (subscriptionType === 'user') {
      if (!extractedUserId) {
        // Should not happen due to prior checks, but as a safeguard
        const errMsg = 'User ID is required for user channel subscription but was not found.';
        logger.error(`[setupWebsocketAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ ${errMsg}` });
        throw new Error(errMsg);
      }
      subMsgPayload.markets = extractedMarkets || []; // For user channel, 'markets' are condition_ids
      // Authentication is required for user channel
      const apiKey = runtime.getSetting('CLOB_API_KEY');
      const apiSecret = runtime.getSetting('CLOB_API_SECRET') || runtime.getSetting('CLOB_SECRET');
      const apiPassphrase =
        runtime.getSetting('CLOB_API_PASSPHRASE') || runtime.getSetting('CLOB_PASS_PHRASE');
      if (!apiKey || !apiSecret || !apiPassphrase) {
        const errMsg =
          'API Key, Secret, and Passphrase are required in settings for user channel WebSocket subscriptions.';
        logger.error(`[setupWebsocketAction] Missing credentials for user subscription: ${errMsg}`);
        if (callback) await callback({ text: `❌ ${errMsg}` });
        throw new Error(errMsg);
      }
      subMsgPayload.auth = { apiKey, secret: apiSecret, passphrase: apiPassphrase };
    } else {
      // market subscription
      if (!extractedMarkets || extractedMarkets.length === 0) {
        const errMsg =
          'At least one market (condition ID or asset ID) is required for market channel subscription.';
        logger.error(`[setupWebsocketAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ ${errMsg}` });
        throw new Error(errMsg);
      }
      // The example uses 'assets_ids' for market subscriptions with token IDs.
      // We are getting 'condition_ids' from the user. This needs clarification from Polymarket docs
      // if 'markets' (condition_ids) can be used directly or if they need to be converted/interpreted as asset_ids for 'market' type.
      // For now, assuming 'markets' (condition_ids) are what's needed, as per 'user' channel example.
      // If 'assets_ids' are strictly token_ids, this part might need adjustment or a new param in LLM extraction.
      subMsgPayload.markets = extractedMarkets; // Using condition_ids here; documentation suggests 'assets_ids' with token_ids for market channel
      logger.warn(
        "[setupWebsocketAction] For 'market' channel, official docs suggest 'assets_ids' (token IDs). Currently using extracted 'markets' (condition IDs). This may need review."
      );
    }

    return new Promise<Content>((resolvePromise, rejectPromise) => {
      try {
        logger.info(`[setupWebsocketAction] Creating new WebSocket connection to: ${wsUrl}`);
        const wsClient = new WebSocket(wsUrl);
        setActiveClobSocketClientReference(wsClient as any); // Store the ws.WebSocket instance

        wsClient.on('open', () => {
          logger.info(
            '[setupWebsocketAction] WebSocket connection opened. Sending subscription message...'
          );
          const messageStr = JSON.stringify(subMsgPayload);
          wsClient.send(messageStr, (err?: Error) => {
            if (err) {
              logger.error('[setupWebsocketAction] Error sending subscription message:', err);
              setActiveClobSocketClientReference(null);
              wsClient.terminate();
              const errorContent: Content = {
                text: `❌ WebSocket Error: Failed to send subscription - ${err.message}`,
              };
              if (callback) callback(errorContent);
              rejectPromise(new Error(`Failed to send subscription: ${err.message}`));
              return;
            }
            logger.info(`[setupWebsocketAction] Subscription message sent: ${messageStr}`);
            let responseText = `🔌 WebSocket connection to ${subscriptionType.toUpperCase()} channel established and subscription sent.`;
            if (subMsgPayload.markets && subMsgPayload.markets.length > 0)
              responseText += ` Subscribed to markets/conditions: ${subMsgPayload.markets.join(', ')}.`;
            if (subMsgPayload.assets_ids && subMsgPayload.assets_ids.length > 0)
              responseText += ` Subscribed to assets: ${subMsgPayload.assets_ids.join(', ')}.`;
            responseText +=
              ' Waiting for real-time updates. Use POLYMARKET_HANDLE_REALTIME_UPDATES to process messages.';

            const responseContent: Content = {
              text: responseText,
              actions: ['POLYMARKET_HANDLE_REALTIME_UPDATES'],
              data: {
                status: 'subscribed',
                subscription: subMsgPayload,
                timestamp: new Date().toISOString(),
              },
            };
            if (callback) callback(responseContent);
            resolvePromise(responseContent);
          });
        });

        wsClient.on('error', (error: Error) => {
          logger.error('[setupWebsocketAction] WebSocket connection error:', error);
          setActiveClobSocketClientReference(null);
          // wsClient.terminate(); // No need to terminate, 'close' will be called
          const errorContent: Content = { text: `❌ WebSocket Error: ${error.message}` };
          if (callback) callback(errorContent);
          rejectPromise(error);
        });

        wsClient.on('close', (code: number, reason: Buffer) => {
          logger.info(
            `[setupWebsocketAction] WebSocket connection closed. Code: ${code}, Reason: ${reason.toString()}`
          );
          setActiveClobSocketClientReference(null);
          // Only reject if it hasn't been resolved already (e.g. by 'open' and successful send)
          // This might lead to double responses if an error occurs after successful connection
          // Consider a flag to check if already resolved/rejected.
          // For now, let's assume if it closes unexpectedly, it's an error state not yet handled.
          // const closeError = new Error(`WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
          // rejectPromise(closeError); // Avoid rejecting again if already resolved
        });

        // The 'message' handler should primarily live in handleRealtimeUpdatesAction
        // But we can log a generic message here for successful setup
        wsClient.once('message', (data: WebSocket.RawData) => {
          logger.info(
            '[setupWebsocketAction] Received first message (indicates successful subscription setup). Further messages handled by POLYMARKET_HANDLE_REALTIME_UPDATES.'
          );
          // Do not resolve/reject here as 'open' handles the primary success case.
        });
      } catch (error: any) {
        logger.error(
          '[setupWebsocketAction] Critical error during WebSocket setup (outside of event handlers):',
          error
        );
        setActiveClobSocketClientReference(null);
        const errorContent: Content = {
          text: `❌ Critical WebSocket Setup Error: ${error.message}`,
        };
        if (callback) callback(errorContent);
        rejectPromise(error);
      }
    });
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Connect to Polymarket WebSocket and subscribe to market 0xMarket123.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Establishing WebSocket connection and subscribing to market 0xMarket123 via Polymarket...',
          actions: ['POLYMARKET_SETUP_WEBSOCKET', 'POLYMARKET_HANDLE_REALTIME_UPDATES'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Listen to my order updates on Polymarket via WebSocket.',
          data: { userId: '0xUserAddress' },
        },
      }, // Assuming LLM extracts or user provides their address
      {
        name: '{{user2}}',
        content: {
          text: 'Connecting to WebSocket and subscribing to your user-specific order updates via Polymarket...',
          actions: ['POLYMARKET_SETUP_WEBSOCKET', 'POLYMARKET_HANDLE_REALTIME_UPDATES'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'Start a realtime feed for markets 0xMarket1, 0xMarket2.' },
      },
      {
        name: '{{user2}}',
        content: {
          text: "I'll setup a realtime feed for those markets via Polymarket.",
          actions: ['POLYMARKET_SETUP_WEBSOCKET', 'POLYMARKET_HANDLE_REALTIME_UPDATES'],
        },
      },
    ],
  ],
};
