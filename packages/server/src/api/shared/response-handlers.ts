/**
 * Shared response handlers for messaging API endpoints
 * Handles http (sync), sse (streaming), and websocket response modes
 */

import type { Response } from 'express';
import type { ElizaOS, Memory } from '@elizaos/core';
import type { UUID, Content } from '@elizaos/core';
import { logger } from '@elizaos/core';
import { type TransportType } from './constants';

/**
 * Message memory type for elizaOS.handleMessage
 * Re-export from core for convenience
 */
export type { Memory };

/**
 * Options for handling transport types
 */
export interface HandleTransportOptions {
  res: Response;
  transport: TransportType;
  elizaOS: ElizaOS;
  agentId: UUID;
  messageMemory: Partial<Memory> & { entityId: UUID; roomId: UUID; content: Content };
  userMessage: unknown;
  /** Additional data to include in http/websocket JSON responses */
  additionalResponseData?: Record<string, unknown>;
  /** Callback for websocket transport - called before returning response */
  onWebSocketTransport?: () => void | Promise<void>;
}

/**
 * @deprecated Use HandleTransportOptions instead
 */
export interface HandleResponseModeOptions {
  res: Response;
  mode: TransportType;
  elizaOS: ElizaOS;
  agentId: UUID;
  messageMemory: Partial<Memory> & { entityId: UUID; roomId: UUID; content: Content };
  userMessage: unknown;
  additionalResponseData?: Record<string, unknown>;
  onWebSocketMode?: () => void | Promise<void>;
}

/**
 * SSE event names
 */
export const SSE_EVENTS = {
  USER_MESSAGE: 'user_message',
  CHUNK: 'chunk',
  DONE: 'done',
  ERROR: 'error',
} as const;

/**
 * Writes an SSE event to the response
 */
function writeSSEEvent(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Sets up SSE headers on the response
 */
function setupSSEHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

/**
 * Handles SSE transport - streaming response
 */
async function handleSSETransport(
  res: Response,
  elizaOS: ElizaOS,
  agentId: UUID,
  messageMemory: Partial<Memory> & { entityId: UUID; roomId: UUID; content: Content },
  userMessage: unknown
): Promise<void> {
  setupSSEHeaders(res);
  writeSSEEvent(res, SSE_EVENTS.USER_MESSAGE, userMessage);

  let chunkIndex = 0;

  try {
    await elizaOS.handleMessage(agentId, messageMemory, {
      onStreamChunk: async (chunk: string, messageId?: UUID) => {
        writeSSEEvent(res, SSE_EVENTS.CHUNK, {
          messageId,
          chunk,
          index: chunkIndex++,
        });
      },
      onResponse: async (responseContent: Content) => {
        writeSSEEvent(res, SSE_EVENTS.DONE, responseContent);
        res.end();
      },
      onError: async (error: Error) => {
        writeSSEEvent(res, SSE_EVENTS.ERROR, { error: error.message });
        res.end();
      },
    });
  } catch (streamError) {
    writeSSEEvent(res, SSE_EVENTS.ERROR, {
      error: streamError instanceof Error ? streamError.message : String(streamError),
    });
    res.end();
  }
}

/**
 * Handles HTTP transport - waits for complete response (sync)
 */
async function handleHttpTransport(
  res: Response,
  elizaOS: ElizaOS,
  agentId: UUID,
  messageMemory: Partial<Memory> & { entityId: UUID; roomId: UUID; content: Content },
  userMessage: unknown,
  additionalResponseData?: Record<string, unknown>
): Promise<void> {
  try {
    const result = await elizaOS.handleMessage(agentId, messageMemory);
    res.status(201).json({
      success: true,
      userMessage,
      agentResponse: result.processing?.responseContent,
      ...additionalResponseData,
    });
  } catch (error) {
    logger.error({ src: 'http', agentId, error }, 'Error in HTTP transport message handling');
    res.status(500).json({
      success: false,
      error: 'Failed to process message in HTTP transport',
    });
  }
}

/**
 * Handles websocket transport - returns immediately
 */
function handleWebSocketTransport(
  res: Response,
  userMessage: unknown,
  additionalResponseData?: Record<string, unknown>,
  onWebSocketTransport?: () => void | Promise<void>
): void {
  // Execute callback if provided (e.g., emit to message bus)
  if (onWebSocketTransport) {
    // Fire and forget - don't await
    Promise.resolve(onWebSocketTransport()).catch((err) => {
      logger.error({ src: 'http', error: err }, 'Error in websocket transport callback');
    });
  }

  res.status(201).json({
    success: true,
    userMessage,
    ...additionalResponseData,
  });
}

/**
 * Main handler for different transport types
 * Routes to appropriate handler based on transport parameter
 */
export async function handleTransport(options: HandleTransportOptions): Promise<void> {
  const {
    res,
    transport,
    elizaOS,
    agentId,
    messageMemory,
    userMessage,
    additionalResponseData,
    onWebSocketTransport,
  } = options;

  switch (transport) {
    case 'sse':
      await handleSSETransport(res, elizaOS, agentId, messageMemory, userMessage);
      break;

    case 'http':
      await handleHttpTransport(
        res,
        elizaOS,
        agentId,
        messageMemory,
        userMessage,
        additionalResponseData
      );
      break;

    case 'websocket':
    default:
      handleWebSocketTransport(res, userMessage, additionalResponseData, onWebSocketTransport);
      break;
  }
}

/**
 * @deprecated Use handleTransport instead
 */
export async function handleResponseMode(options: HandleResponseModeOptions): Promise<void> {
  return handleTransport({
    res: options.res,
    transport: options.mode,
    elizaOS: options.elizaOS,
    agentId: options.agentId,
    messageMemory: options.messageMemory,
    userMessage: options.userMessage,
    additionalResponseData: options.additionalResponseData,
    onWebSocketTransport: options.onWebSocketMode,
  });
}
