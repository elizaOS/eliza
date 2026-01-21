import type { HandlerCallback } from "./components";
import type { Room } from "./environment";
import type { Memory } from "./memory";
import type { Content, Media, MentionContext, UUID } from "./primitives";
import type {
  MessageProcessingMode as ProtoMessageProcessingMode,
  MessageProcessingOptions as ProtoMessageProcessingOptions,
  ShouldRespondModelType as ProtoShouldRespondModelType,
} from "./proto.js";
import type { IAgentRuntime } from "./runtime";
import type { State } from "./state";

/**
 * Configuration options for message processing
 */
export interface MessageProcessingOptions
  extends Omit<
    ProtoMessageProcessingOptions,
    | "$typeName"
    | "$unknown"
    | "maxRetries"
    | "timeoutDuration"
    | "useMultiStep"
    | "maxMultiStepIterations"
    | "shouldRespondModel"
  > {
  maxRetries?: number;
  timeoutDuration?: number;
  useMultiStep?: boolean;
  maxMultiStepIterations?: number;
  shouldRespondModel?: ShouldRespondModelType;
  onStreamChunk?: (chunk: string, messageId?: string) => Promise<void>;
}

/**
 * Result of message processing
 */
export interface MessageProcessingResult {
  didRespond: boolean;
  responseContent?: Content | null;
  responseMessages: Memory[];
  state?: State;
  mode?: MessageProcessingMode;
  skipEvaluation?: boolean;
  reason?: string;
}

/**
 * Response decision from the shouldRespond logic
 */
export interface ResponseDecision {
  shouldRespond: boolean;
  skipEvaluation: boolean;
  reason: string;
}

export type ShouldRespondModelType =
  | ProtoShouldRespondModelType
  | "small"
  | "large";
export type MessageProcessingMode =
  | ProtoMessageProcessingMode
  | "simple"
  | "actions"
  | "none";

/**
 * Core interface for message handling service.
 * This service is responsible for processing incoming messages and generating responses.
 *
 * Implementations of this interface control the entire message processing pipeline,
 * including:
 * - Message validation and memory creation
 * - Response decision logic (shouldRespond)
 * - Single-shot or multi-step processing
 * - Action execution and evaluation
 *
 * @example
 * ```typescript
 * // Custom implementation
 * class CustomMessageService implements IMessageService {
 *   async handleMessage(runtime, message, callback) {
 *     // Your custom message handling logic
 *     return {
 *       didRespond: true,
 *       responseContent: { text: "Custom response" },
 *       responseMessages: [],
 *       state: {},
 *       mode: 'simple'
 *     };
 *   }
 *
 *   shouldRespond(runtime, message, room, mentionContext) {
 *     // Your custom response decision logic
 *     return { shouldRespond: true, skipEvaluation: true, reason: "custom" };
 *   }
 * }
 *
 * // Register in runtime
 * await runtime.registerService(CustomMessageService);
 * ```
 */
export interface IMessageService {
  /**
   * Main entry point for message processing.
   * This method orchestrates the entire message handling flow.
   *
   * @param runtime - The agent runtime instance
   * @param message - The incoming message to process
   * @param callback - Callback function to send responses
   * @param options - Optional processing options
   * @returns Promise resolving to the processing result
   */
  handleMessage(
    runtime: IAgentRuntime,
    message: Memory,
    callback?: HandlerCallback,
    options?: MessageProcessingOptions,
  ): Promise<MessageProcessingResult>;

  /**
   * Determines whether the agent should respond to a message.
   * Uses simple rules for obvious cases (DM, mentions) and defers to LLM for ambiguous cases.
   *
   * @param runtime - The agent runtime instance
   * @param message - The message to evaluate
   * @param room - The room context (optional)
   * @param mentionContext - Platform mention/reply context (optional)
   * @returns Response decision with reasoning
   */
  shouldRespond(
    runtime: IAgentRuntime,
    message: Memory,
    room?: Room,
    mentionContext?: MentionContext,
  ): ResponseDecision;

  /**
   * Processes attachments in a message (images, documents, etc.)
   * Generates descriptions for images and extracts text from documents.
   *
   * @param runtime - The agent runtime instance
   * @param attachments - Array of media attachments to process
   * @returns Promise resolving to processed attachments with descriptions
   */
  processAttachments?(
    runtime: IAgentRuntime,
    attachments: Media[],
  ): Promise<Media[]>;

  /**
   * Deletes a message from the agent's memory.
   * This method handles the actual deletion logic that was previously in event handlers.
   *
   * @param runtime - The agent runtime instance
   * @param message - The message memory to delete
   * @returns Promise resolving when deletion is complete
   */
  deleteMessage(runtime: IAgentRuntime, message: Memory): Promise<void>;

  /**
   * Clears all messages from a channel/room.
   * This method handles bulk deletion of all message memories in a room.
   *
   * @param runtime - The agent runtime instance
   * @param roomId - The room ID to clear messages from
   * @param channelId - The original channel ID (for logging)
   * @returns Promise resolving when channel is cleared
   */
  clearChannel(
    runtime: IAgentRuntime,
    roomId: UUID,
    channelId: string,
  ): Promise<void>;
}
