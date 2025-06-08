import type { Content, UUID } from './primitives';
import type { IAgentRuntime } from './runtime';

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
