import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  logger,
} from '@elizaos/core';
import WebSocket from 'ws';

// Module-level variable to store the active WebSocket client instance
let activeWebSocketClient: WebSocket | null = null;

// Function to allow other modules (like setupWebsocketAction) to set the client instance
export function setActiveClobSocketClientReference(client: WebSocket | null) {
  activeWebSocketClient = client;
  if (client) {
    logger.info('[handleRealtimeUpdates] Active WebSocket client reference set.');
  } else {
    logger.info('[handleRealtimeUpdates] Active WebSocket client reference cleared.');
  }
}

// Function to allow other modules to get the client instance
export function getActiveWebSocketClient(): WebSocket | null {
  return activeWebSocketClient;
}

// Define types for event payloads we expect from Polymarket WebSocket
// These should align with actual data structures from Polymarket WSS documentation and socketExample.ts
// This is a generic example; specific event types might vary.
interface PolymarketWebSocketEvent {
  type: string; // e.g., 'book_update', 'order_update', 'trade', etc.
  data: any;
  [key: string]: any;
}

function registerEventHandlers(
  wsClient: WebSocket,
  runtime: IAgentRuntime,
  callback?: HandlerCallback
) {
  logger.info('[handleRealtimeUpdates] Registering event handlers on WebSocket client.');

  // Detach existing listeners first to prevent duplicates if called multiple times
  // For 'ws', this means calling removeAllListeners for specific events if attaching new ones,
  // or ensuring 'on' replaces previous listeners for the same event type (default behavior for .on typically).
  // For simplicity, we assume .on will overwrite or that fresh client means fresh listeners.
  // wsClient.removeAllListeners('message'); // Example if needed
  // wsClient.removeAllListeners('error');
  // wsClient.removeAllListeners('close');

  wsClient.on('message', (rawData: WebSocket.RawData) => {
    const messageString = rawData.toString();
    logger.info(`[WS Event] Message: ${messageString}`);
    try {
      // Polymarket might send 'PONG' or other control messages as strings
      if (messageString === 'PONG') {
        logger.info('[WS Event] Received PONG');
        return; // Handle PONG keep-alive
      }
      if (messageString === 'PING') {
        // Though client usually sends PING, server might too
        logger.info('[WS Event] Received PING, sending PONG');
        wsClient.pong();
        return;
      }

      const eventData: PolymarketWebSocketEvent = JSON.parse(messageString);
      // TODO: Add more specific parsing and handling based on eventData.type
      // For example, if (eventData.type === 'book_l2_update') { ... }

      const notification: Content = {
        text: `🔔 **WebSocket Update**: Type: \`${eventData.event || eventData.type || 'Unknown'}\`. Data: ${JSON.stringify(eventData.data || eventData).substring(0, 200)}...`,
        data: { eventType: 'polymarketUpdate', payload: eventData },
      };
      if (callback) callback(notification);
      else
        logger.warn(
          '[handleRealtimeUpdates] WebSocket message received, but no callback to send it to.'
        );
    } catch (parseError) {
      logger.error(
        '[WS Event] Error parsing message JSON or non-JSON message received:',
        parseError,
        `Raw: ${messageString}`
      );
      // Handle non-JSON messages if necessary, or log as an unexpected format
      const notification: Content = {
        text: `⚠️ **WebSocket Message**: Received non-JSON or unparseable message: ${messageString.substring(0, 200)}...`,
        data: { eventType: 'polymarketRawUpdate', payload: messageString },
      };
      if (callback) callback(notification);
    }
  });

  wsClient.on('error', (error: Error) => {
    logger.error('[WS Event] Error:', error);
    const notification: Content = {
      text: `⚠️ **WebSocket Error**: ${error.message || 'An unknown WebSocket error occurred.'} `,
      data: {
        eventType: 'websocketError',
        payload: { message: error.message, name: error.name, stack: error.stack },
      },
    };
    if (callback) callback(notification);
    // No need to call setActiveClobSocketClientReference(null) here as 'close' will handle it.
  });

  wsClient.on('close', (code: number, reason: Buffer) => {
    logger.info(
      `[WS Event] Close: WebSocket connection closed. Code: ${code}, Reason: ${reason.toString()}`
    );
    const notification: Content = {
      text: `🔌 **WebSocket Closed**. Code: ${code}, Reason: ${reason.toString()}`,
      data: { eventType: 'websocketClose', payload: { code, reason: reason.toString() } },
    };
    if (callback) callback(notification);
    setActiveClobSocketClientReference(null); // Clear the shared client reference
  });

  // Handle ping/pong for keep-alive, as seen in socketExample.ts
  // The server might also send PINGs that the 'ws' library handles automatically by sending PONGs.
  // Explicitly sending PING from client side can also be done if required by Polymarket.
  // For now, rely on automatic PONG responses by 'ws' and server PINGs, or PINGs sent by setupWebsocket if implemented there.

  logger.info('[handleRealtimeUpdates] WebSocket event handlers registered.');
}

export const handleRealtimeUpdatesAction: Action = {
  name: 'POLYMARKET_HANDLE_REALTIME_UPDATES',
  similes: [
    'SETUP_POLYMARKET_EVENT_LISTENERS',
    'START_LISTENING_TO_POLYMARKET_WS',
    'PROCESS_POLYMARKET_NOTIFICATIONS',
  ],
  description:
    'Sets up and manages event listeners for real-time updates from an active Polymarket WebSocket connection (using ws library).',

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    logger.info('[handleRealtimeUpdatesAction] Validate called.');
    if (!activeWebSocketClient) {
      logger.warn(
        '[handleRealtimeUpdatesAction] No active WebSocket client (ws). Run SETUP_WEBSOCKET first.'
      );
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info('[handleRealtimeUpdatesAction] Handler called.');

    if (!activeWebSocketClient) {
      const errorMsg =
        'No active Polymarket WebSocket client (ws). Please run SETUP_WEBSOCKET first to connect.';
      logger.warn(`[handleRealtimeUpdatesAction] ${errorMsg}`);
      if (callback) await callback({ text: `🟡 ${errorMsg}` });
      return { text: `🟡 ${errorMsg}` };
    }

    try {
      // Check WebSocket state
      if (activeWebSocketClient.readyState !== WebSocket.OPEN) {
        // WebSocket.OPEN is 1
        const stateName =
          ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'][activeWebSocketClient.readyState] ||
          'UNKNOWN';
        const warnMsg = `WebSocket client exists but is not in OPEN state (current: ${stateName}). Listeners will be attached/re-confirmed, but will only fire effectively once OPEN.`;
        logger.warn(`[handleRealtimeUpdatesAction] ${warnMsg}`);
        // We can still proceed to attach listeners. They will become active once connection is OPEN.
      }

      registerEventHandlers(activeWebSocketClient, runtime, callback);

      const responseText =
        '👂 Event listeners for Polymarket WebSocket (ws) updates are now active (or re-confirmed).';
      const responseContent: Content = {
        text: responseText,
        data: {
          status: 'listening',
          clientState: activeWebSocketClient.readyState,
          timestamp: new Date().toISOString(),
        },
      };
      return responseContent;
    } catch (error: any) {
      logger.error('[handleRealtimeUpdatesAction] Error setting up event handlers:', error);
      const errorMessage = error.message || 'Unknown error.';
      const errorContent: Content = {
        text: `❌ **Error setting up WebSocket event handlers**: ${errorMessage}`,
        data: { error: errorMessage, timestamp: new Date().toISOString() },
      };
      if (callback) await callback(errorContent);
      throw error;
    }
  },

  examples: [
    [
      { name: '{{user1}}', content: { text: 'Start listening for Polymarket updates.' } },
      {
        name: '{{user2}}',
        content: {
          text: "Okay, I'll ensure I'm listening for real-time updates from Polymarket if connected.",
          action: 'POLYMARKET_HANDLE_REALTIME_UPDATES',
        },
      },
    ],
    [
      { name: '{{user1}}', content: { text: 'Make sure you process Polymarket notifications.' } },
      {
        name: '{{user2}}',
        content: {
          text: 'Checking and activating Polymarket WebSocket event handlers.',
          action: 'POLYMARKET_HANDLE_REALTIME_UPDATES',
        },
      },
    ],
  ],
};
