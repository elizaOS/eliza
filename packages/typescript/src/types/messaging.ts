import type { Memory } from "./memory";
import type { Content, UUID } from "./primitives";
import type {
  MessageResult as ProtoMessageResult,
  MessageStreamChunkPayload as ProtoMessageStreamChunkPayload,
  MessageStreamErrorPayload as ProtoMessageStreamErrorPayload,
  TargetInfo as ProtoTargetInfo,
} from "./proto.js";
import type { IAgentRuntime } from "./runtime";

/**
 * Information describing the target of a message.
 */
export interface TargetInfo extends ProtoTargetInfo {
  roomId?: UUID;
  entityId?: UUID;
}

/**
 * Function signature for handlers responsible for sending messages to specific platforms.
 */
export type SendHandlerFunction = (
  runtime: IAgentRuntime,
  target: TargetInfo,
  content: Content,
) => Promise<void>;

export enum SOCKET_MESSAGE_TYPE {
  ROOM_JOINING = 1,
  SEND_MESSAGE = 2,
  MESSAGE = 3,
  ACK = 4,
  THINKING = 5,
  CONTROL = 6,
}

/**
 * WebSocket/SSE event names for message streaming.
 * Used for real-time streaming of agent responses to clients.
 *
 * Event flow:
 * 1. First `messageStreamChunk` indicates stream start
 * 2. Multiple `messageStreamChunk` events with text chunks
 * 3. `messageBroadcast` event with complete message (indicates stream end)
 * 4. `messageStreamError` if an error occurs during streaming
 */
export const MESSAGE_STREAM_EVENT = {
  /** Text chunk during streaming. First chunk indicates stream start. */
  messageStreamChunk: "messageStreamChunk",
  /** Error occurred during streaming */
  messageStreamError: "messageStreamError",
  /** Complete message broadcast (existing event, indicates stream end) */
  messageBroadcast: "messageBroadcast",
} as const;

export type MessageStreamEventType =
  (typeof MESSAGE_STREAM_EVENT)[keyof typeof MESSAGE_STREAM_EVENT];

/**
 * Payload for messageStreamChunk event
 * Uses camelCase for client-facing WebSocket events (JS convention)
 */
export interface MessageStreamChunkPayload
  extends Omit<ProtoMessageStreamChunkPayload, "messageId" | "agentId"> {
  messageId: UUID;
  agentId: UUID;
}

/**
 * Payload for messageStreamError event
 * Uses camelCase for client-facing WebSocket events (JS convention)
 */
export interface MessageStreamErrorPayload
  extends Omit<ProtoMessageStreamErrorPayload, "messageId" | "agentId"> {
  messageId: UUID;
  agentId: UUID;
}

/**
 * Control message actions that can be sent to the frontend
 */
export type ControlMessageAction = "disable_input" | "enable_input";

/**
 * Payload for UI control messages
 */
export interface UIControlPayload {
  /** Action to perform */
  action: ControlMessageAction;
  /** Optional target element identifier */
  target?: string;
  /** Optional reason for the action */
  reason?: string;
  /** Optional duration in milliseconds */
  duration?: number;
}

/**
 * Interface for control messages sent from the backend to the frontend
 * to manage UI state and interaction capabilities
 */
export interface ControlMessage {
  /** Message type identifier */
  type: "control";
  /** Control message payload */
  payload: UIControlPayload;
  /** Room ID to ensure signal is directed to the correct chat window */
  roomId: UUID;
}

/**
 * Handler options for async message processing (User → Agent)
 * Follows the core pattern: HandlerOptions, HandlerCallback, etc.
 */
export interface MessageHandlerOptions {
  /**
   * Called when the agent generates a response
   * If provided, method returns immediately (async mode)
   * If not provided, method waits for response (sync mode)
   */
  onResponse?: (content: Content) => Promise<void>;

  /**
   * Called if an error occurs during processing
   */
  onError?: (error: Error) => Promise<void>;

  /**
   * Called when processing is complete
   */
  onComplete?: () => Promise<void>;
}

/**
 * Result of sending a message to an agent (User → Agent)
 * Follows the core pattern: ActionResult, ProviderResult, GenerateTextResult, etc.
 */
export interface MessageResult
  extends Omit<
    ProtoMessageResult,
    "messageId" | "userMessage" | "agentResponses"
  > {
  messageId: UUID;
  userMessage?: Memory;
  agentResponses?: Content[];
}
