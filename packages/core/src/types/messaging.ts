import type { UUID } from './uuid';
import type { IAgentRuntime } from './runtime';

/**
 * Represents the content of a memory, message, or other information
 */
export interface Content {
  /** The agent's internal thought process */
  thought?: string;

  /** The main text content visible to users */
  text?: string;

  /** Optional actions to be performed */
  actions?: string[];

  /** Optional providers to use for context generation */
  providers?: string[];

  /** Optional source/origin of the content */
  source?: string;

  /** Optional target/destination for responses */
  target?: string;

  /** URL of the original message/post (e.g. tweet URL, Discord message link) */
  url?: string;

  /** UUID of parent message if this is a reply/thread */
  inReplyTo?: UUID;

  /** Array of media attachments */
  attachments?: Media[];

  /** room type */
  channelType?: string;

  /**
   * Additional dynamic properties
   * Use specific properties above instead of this when possible
   */
  [key: string]: unknown;
}

/**
 * Represents a media attachment
 */
export type Media = {
  /** Unique identifier */
  id: string;

  /** Media URL */
  url: string;

  /** Media title */
  title?: string;

  /** Media source */
  source?: string;

  /** Media description */
  description?: string;

  /** Text content */
  text?: string;

  /** Content type */
  contentType?: ContentType;
};

export enum ContentType {
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio',
  DOCUMENT = 'document',
  LINK = 'link',
}

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
