import type { UUID, Content } from './primitives';
import type { Memory } from './memory';
import type { IAgentRuntime } from './runtime';
import type { MessageProcessingResult } from '../services/message-service';

/**
 * Options for sending a message to an agent
 */
export interface SendMessageOptions {
  /**
   * Called when the agent generates a response (ASYNC MODE)
   * If provided, method returns immediately (fire & forget)
   * If not provided, method waits for response (SYNC MODE)
   *
   * @param content - The response content from the agent
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

  /**
   * Maximum number of retries for failed messages
   */
  maxRetries?: number;

  /**
   * Timeout duration in milliseconds
   */
  timeoutDuration?: number;

  /**
   * Enable multi-step message processing
   */
  useMultiStep?: boolean;

  /**
   * Maximum multi-step iterations
   */
  maxMultiStepIterations?: number;
}

/**
 * Result of sending a message to an agent
 */
export interface SendMessageResult {
  /** ID of the user message */
  messageId: UUID;

  /** The user message that was created */
  userMessage: Memory;

  /**
   * Processing result (only in SYNC mode)
   * Contains information about message processing success and agent responses
   */
  result?: MessageProcessingResult;
}

/**
 * Interface for the ElizaOS orchestrator
 * Provides unified messaging API across all platforms
 */
export interface IElizaOS {
  /**
   * Send a message to an agent using the unified messaging API.
   *
   * This method provides a standardized entry point for message processing with two modes:
   *
   * **SYNC MODE (default)**: Waits for agent response before returning
   * - Returns the complete processing result including agent responses
   * - Useful when you need to immediately act on the agent's reply
   * - Usage: Don't provide `onResponse` callback in options
   *
   * **ASYNC MODE**: Returns immediately, calls back when agent responds
   * - Non-blocking, suitable for high-throughput scenarios
   * - Provides callbacks for response, errors, and completion
   * - Usage: Provide `onResponse` callback in options
   *
   * Features:
   * - Auto-fills missing fields (id, agentId, createdAt)
   * - Ensures connections exist before processing
   * - Handles entity context (RLS) if available
   * - Supports retries and timeouts
   *
   * @param agentId - The ID of the agent to send the message to
   * @param message - The message to send (partial Memory with required fields: entityId, roomId, content)
   * @param options - Optional processing options (callbacks, retries, timeouts, etc.)
   * @returns Promise with message result (includes agent responses in SYNC mode)
   *
   * @example
   * // SYNC mode - wait for response
   * const result = await elizaOS.sendMessage(agentId, {
   *   entityId: userId,
   *   roomId: channelId,
   *   content: { text: "Hello!" }
   * });
   * console.log(result.result.responses); // Agent's replies
   *
   * @example
   * // ASYNC mode - fire and forget
   * await elizaOS.sendMessage(agentId, message, {
   *   onResponse: async (content) => {
   *     console.log("Agent replied:", content.text);
   *   },
   *   onError: async (error) => {
   *     console.error("Processing failed:", error);
   *   }
   * });
   */
  sendMessage(
    agentId: UUID,
    message: Partial<Memory> & {
      entityId: UUID;
      roomId: UUID;
      content: Content;
      worldId?: UUID;
    },
    options?: SendMessageOptions
  ): Promise<SendMessageResult>;

  /**
   * Get an agent runtime by ID.
   *
   * Use this to access the runtime instance of a registered agent,
   * allowing direct interaction with agent services, state, and methods.
   *
   * @param agentId - The UUID of the agent
   * @returns The agent runtime instance or undefined if agent not found
   *
   * @example
   * const runtime = elizaOS.getAgent(agentId);
   * if (runtime) {
   *   console.log("Agent character:", runtime.character.name);
   *   await runtime.messageService.handleMessage(...);
   * }
   */
  getAgent(agentId: UUID): IAgentRuntime | undefined;
}