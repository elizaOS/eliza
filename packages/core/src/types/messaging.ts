import type { Content, UUID } from './primitives';
import type { IAgentRuntime } from './runtime';
import type { Memory } from './memory';

/**
 * Information describing the target of a message.
 */
export interface TargetInfo {
  source: string; // Platform identifier (e.g., 'discord', 'telegram', 'websocket-api')
  roomId?: UUID; // Target room ID (platform-specific or runtime-specific)
  channelId?: string; // Platform-specific channel/chat ID
  serverId?: string; // Platform-specific server/guild ID
  entityId?: UUID; // Target user ID (for DMs)
  threadId?: string; // Platform-specific thread ID (e.g., Telegram topics)
  // Add other relevant platform-specific identifiers as needed
}

/**
 * Function signature for handlers responsible for sending messages to specific platforms.
 */
export type SendHandlerFunction = (
  runtime: IAgentRuntime,
  target: TargetInfo,
  content: Content
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
 * Interface for control messages sent from the backend to the frontend
 * to manage UI state and interaction capabilities
 */
export interface ControlMessage {
  /** Message type identifier */
  type: 'control';

  /** Control message payload */
  payload: {
    /** Action to perform */
    action: 'disable_input' | 'enable_input';

    /** Optional target element identifier */
    target?: string;

    /** Additional optional parameters */
    [key: string]: unknown;
  };

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
export interface MessageResult {
  /** ID of the user message */
  messageId: UUID;

  /** The user message that was created (only in sync mode) */
  userMessage?: Memory;

  /**
   * Agent responses (only in sync mode)
   * Empty in async mode - use onResponse callback instead
   */
  agentResponses?: Content[];

  /** Usage information for billing (only in sync mode) */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    model: string;
  };
}
