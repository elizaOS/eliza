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
import { initializeClobClient } from '../utils/clobClient';

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
  name: 'SETUP_WEBSOCKET',
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
    let pingIntervalId: NodeJS.Timeout | null = null; // Declare pingIntervalId

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

      // Revised regex logic: first check for market keyword, then search for ID patterns.
      const hasMarketKeyword = /market(s)?/i.test(text);
      if (hasMarketKeyword) {
        const idRegex = /(0x[0-9a-fA-F]{64})|([a-zA-Z0-9_.-]+condition-[0-9]+)/gi;
        const idMatches = Array.from(text.matchAll(idRegex));
        if (idMatches.length > 0) {
          // Filter out null/undefined matches and take the first actual captured group from each match
          const foundMarkets = idMatches.map((m) => m[1] || m[2]).filter((id) => !!id);
          if (foundMarkets.length > 0) {
            extractedMarkets = foundMarkets;
            logger.info(
              `[setupWebsocketAction] Regex fallback extracted markets: ${JSON.stringify(extractedMarkets)}`
            );
          }
        }
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
          'At least one market (condition ID) is required for market channel subscription.';
        logger.error(`[setupWebsocketAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ ${errMsg}` });
        throw new Error(errMsg);
      }

      // For market channel, we need to resolve condition ID(s) to asset ID(s)
      // Prioritize markets mentioned in the current message
      const currentMessageText = message.content?.text || '';
      let conditionIdToFetch: string;

      // Find market ID that appears in the current message
      const currentMessageMarket = extractedMarkets.find((market) =>
        currentMessageText.toLowerCase().includes(market.toLowerCase())
      );

      // Use the market from current message, or fall back to the last (most recent) market
      conditionIdToFetch = currentMessageMarket || extractedMarkets[extractedMarkets.length - 1];

      logger.info(
        `[setupWebsocketAction] Market subscription: Fetching asset IDs for condition ID: ${conditionIdToFetch}`
      );

      try {
        const clobClient = await initializeClobClient(runtime);
        const marketDetails = await clobClient.getMarket(conditionIdToFetch);
        logger.info(
          `[setupWebsocketAction] Fetched market details for ${conditionIdToFetch}: ${JSON.stringify(marketDetails, null, 2)}`
        ); // Log market details

        if (marketDetails && marketDetails.tokens && marketDetails.tokens.length > 0) {
          const assetIds = marketDetails.tokens.map((token) => token.token_id).filter((id) => !!id);
          if (assetIds.length > 0) {
            subMsgPayload.assets_ids = assetIds;
            // Remove the markets field as we are using assets_ids for market type subscription
            delete subMsgPayload.markets;
            logger.info(
              `[setupWebsocketAction] Subscribing to asset IDs: ${JSON.stringify(assetIds)} for condition ID ${conditionIdToFetch}`
            );
          } else {
            throw new Error(`No asset IDs found for condition ID: ${conditionIdToFetch}`);
          }
        } else {
          throw new Error(
            `Could not retrieve market details or tokens for condition ID: ${conditionIdToFetch}`
          );
        }
      } catch (marketError: any) {
        const errMsg = `Error fetching market details to get asset IDs: ${marketError.message}`;
        logger.error(`[setupWebsocketAction] ${errMsg}`);
        if (callback) await callback({ text: `❌ ${errMsg}` });
        throw new Error(errMsg);
      }
    }

    return new Promise<Content>((resolvePromise, rejectPromise) => {
      let retryCount = 0;
      const MAX_RETRIES = 3;
      let hasResolved = false; // Flag to prevent multiple resolutions

      const attemptConnection = () => {
        try {
          logger.info(
            `[setupWebsocketAction] Creating new WebSocket connection to: ${wsUrl} (attempt ${retryCount + 1}/${MAX_RETRIES + 1})`
          );
          const wsClient = new WebSocket(wsUrl);
          setActiveClobSocketClientReference(wsClient as any);

          wsClient.on('open', () => {
            logger.info(
              '[setupWebsocketAction] WebSocket connection opened. Sending subscription message...'
            );
            const messageStr = JSON.stringify(subMsgPayload);
            wsClient.send(messageStr, (err?: Error) => {
              if (err) {
                logger.error('[setupWebsocketAction] Error sending subscription message:', err);
                if (pingIntervalId) {
                  clearInterval(pingIntervalId);
                  pingIntervalId = null;
                } // Clear interval on error
                setActiveClobSocketClientReference(null);
                wsClient.terminate();
                const errorContent: Content = {
                  text: `❌ WebSocket Error: Failed to send subscription - ${err.message}`,
                };
                if (callback) callback(errorContent);
                if (!hasResolved) {
                  hasResolved = true;
                  rejectPromise(new Error(`Failed to send subscription: ${err.message}`));
                }
                return;
              }
              logger.info(`[setupWebsocketAction] Subscription message sent: ${messageStr}`);
              let responseText = `🔌 WebSocket connection to ${subscriptionType.toUpperCase()} channel established and subscription sent.`;
              if (subMsgPayload.markets && subMsgPayload.markets.length > 0)
                responseText += ` Subscribed to markets/conditions: ${subMsgPayload.markets.join(', ')}.`;
              if (subMsgPayload.assets_ids && subMsgPayload.assets_ids.length > 0)
                responseText += ` Subscribed to assets: ${subMsgPayload.assets_ids.join(', ')}.`;
              responseText +=
                ' Waiting for real-time updates. Use HANDLE_REALTIME_UPDATES to process messages.';

              // Start sending pings every 30 seconds
              if (pingIntervalId) {
                clearInterval(pingIntervalId);
              } // Clear any existing (should not happen here)
              pingIntervalId = setInterval(() => {
                if (wsClient.readyState === WebSocket.OPEN) {
                  // Use imported WebSocket for WebSocket.OPEN
                  logger.info('[setupWebsocketAction] Sending WebSocket ping');
                  wsClient.ping();
                }
              }, 30000);

              const responseContent: Content = {
                text: responseText,
                actions: ['HANDLE_REALTIME_UPDATES'],
                data: {
                  status: 'subscribed',
                  subscription: subMsgPayload,
                  timestamp: new Date().toISOString(),
                },
              };
              if (callback) callback(responseContent);
              if (!hasResolved) {
                hasResolved = true;
                resolvePromise(responseContent);
              }
            });
          });

          wsClient.on('error', (error: Error) => {
            logger.error('[setupWebsocketAction] WebSocket connection error:', error);
            if (pingIntervalId) {
              clearInterval(pingIntervalId);
              pingIntervalId = null;
            } // Clear interval
            setActiveClobSocketClientReference(null);
            // wsClient.terminate(); // No need to terminate, 'close' will be called
            const errorContent: Content = { text: `❌ WebSocket Error: ${error.message}` };
            if (callback) callback(errorContent);
            if (!hasResolved) {
              hasResolved = true;
              rejectPromise(error);
            }
          });

          wsClient.on('close', (code: number, reason: Buffer) => {
            logger.info(
              `[setupWebsocketAction] WebSocket connection closed. Code: ${code}, Reason: ${reason.toString()}`
            );
            if (pingIntervalId) {
              clearInterval(pingIntervalId);
              pingIntervalId = null;
            } // Clear interval
            setActiveClobSocketClientReference(null);

            // Retry logic for abnormal closures (code 1006) and other connection issues
            if ((code === 1006 || code === 1000) && retryCount < MAX_RETRIES && !hasResolved) {
              retryCount++;
              const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff: 2s, 4s, 8s
              logger.info(
                `[setupWebsocketAction] Connection closed (code ${code}). Retrying in ${delay}ms (attempt ${retryCount}/${MAX_RETRIES})`
              );
              setTimeout(attemptConnection, delay);
              return;
            }

            // If we've exhausted retries or this is a different close reason, and haven't resolved yet
            if (!hasResolved) {
              hasResolved = true;
              const closeError = new Error(
                `WebSocket closed after ${retryCount} retries. Code: ${code}, Reason: ${reason.toString()}`
              );
              rejectPromise(closeError);
            }
          });

          // The 'message' handler should primarily live in handleRealtimeUpdatesAction
          // But we can log a generic message here for successful setup
          wsClient.once('message', (data: WebSocket.RawData) => {
            logger.info(
              '[setupWebsocketAction] Received first message (indicates successful subscription setup). Further messages handled by HANDLE_REALTIME_UPDATES.'
            );
            // Do not resolve/reject here as 'open' handles the primary success case.
          });
        } catch (error: any) {
          logger.error(
            '[setupWebsocketAction] Critical error during WebSocket setup (outside of event handlers):',
            error
          );
          if (pingIntervalId) {
            clearInterval(pingIntervalId);
            pingIntervalId = null;
          } // Clear interval
          setActiveClobSocketClientReference(null);
          const errorContent: Content = {
            text: `❌ Critical WebSocket Setup Error: ${error.message}`,
          };
          if (callback) callback(errorContent);
          if (!hasResolved) {
            hasResolved = true;
            rejectPromise(error);
          }
        }
      };

      // Start the initial connection attempt
      attemptConnection();
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
          text: 'Establishing WebSocket connection and subscribing to market 0xMarket123...',
          actions: ['SETUP_WEBSOCKET', 'HANDLE_REALTIME_UPDATES'],
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
          text: 'Connecting to WebSocket and subscribing to your user-specific order updates...',
          actions: ['SETUP_WEBSOCKET', 'HANDLE_REALTIME_UPDATES'],
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: {
          text: 'Subscribe to trades for markets 0xMarketA, 0xMarketB and my user ID 0xMyUser.',
        },
      },
      {
        name: '{{user2}}',
        content: {
          text: 'Connecting and subscribing to markets 0xMarketA, 0xMarketB and user 0xMyUser...',
          actions: ['SETUP_WEBSOCKET', 'HANDLE_REALTIME_UPDATES'],
        },
      },
    ],
  ],
};
