import type {
  MessageProcessingOptions,
  MessageProcessingResult,
} from "../services/message-service";
import type { Character } from "./agent";
import type { ActionResult } from "./components";
import type { Memory } from "./memory";
import type { Content, UUID } from "./primitives";
import type { IAgentRuntime } from "./runtime";
import type { State } from "./state";

/**
 * Payload for message batch operations
 */
export interface MessageOperationPayload {
  entityId: UUID;
  roomId: UUID;
  content: Content;
  worldId?: UUID;
}

/**
 * Payload for action batch operations
 */
export interface ActionOperationPayload {
  action: string;
  params?: Record<string, string | number | boolean>;
}

/**
 * Payload for evaluate batch operations
 */
export interface EvaluateOperationPayload {
  evaluator: string;
  context: Record<string, string | number | boolean>;
}

/**
 * Discriminated union for batch operations
 */
export type BatchOperation =
  | {
      agentId: UUID;
      operation: "message";
      payload: MessageOperationPayload;
    }
  | {
      agentId: UUID;
      operation: "action";
      payload: ActionOperationPayload;
    }
  | {
      agentId: UUID;
      operation: "evaluate";
      payload: EvaluateOperationPayload;
    };

/**
 * Result types for each operation type
 */
export interface MessageBatchResult {
  agentId: UUID;
  success: boolean;
  result?: Memory;
  error?: Error;
}

export interface ActionBatchResult {
  agentId: UUID;
  success: boolean;
  result?: ActionResult;
  error?: Error;
}

export interface EvaluateBatchResult {
  agentId: UUID;
  success: boolean;
  result?: { passed: boolean; feedback?: string };
  error?: Error;
}

/**
 * Union type for batch operation results
 */
export type BatchResult =
  | MessageBatchResult
  | ActionBatchResult
  | EvaluateBatchResult;

/**
 * Read-only runtime accessor
 */
export interface ReadonlyRuntime {
  getAgent(id: UUID): IAgentRuntime | undefined;
  getAgents(): IAgentRuntime[];
  getState(agentId: UUID): State | undefined;
}

/**
 * Health status for an agent
 */
export interface HealthStatus {
  alive: boolean;
  responsive: boolean;
  memoryUsage?: number;
  uptime?: number;
}

/**
 * Update operation for an agent
 */
export interface AgentUpdate {
  id: UUID;
  character: Partial<Character>;
}

/**
 * Options for handling a message to an agent.
 * Extends MessageProcessingOptions with orchestration callbacks for async mode.
 */
export interface HandleMessageOptions extends MessageProcessingOptions {
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
}

/**
 * Result of handling a message to an agent
 */
export interface HandleMessageResult {
  /** ID of the user message */
  messageId: UUID;

  /** The user message that was created */
  userMessage: Memory;

  /**
   * Processing result (only in SYNC mode)
   * Contains information about message processing success and agent responses
   * Access via result.processing instead of result.result for clarity
   */
  processing?: MessageProcessingResult;
}

/**
 * Interface for the elizaOS orchestrator
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
   * const result = await elizaOS.handleMessage(agentId, {
   *   entityId: userId,
   *   roomId: channelId,
   *   content: { text: "Hello!" }
   * });
   * console.log(result.processing && result.processing.responseContent); // Agent's response
   *
   * @example
   * // ASYNC mode - fire and forget
   * await elizaOS.handleMessage(agentId, message, {
   *   onResponse: async (content) => {
   *     console.log("Agent replied:", content.text);
   *   },
   *   onError: async (error) => {
   *     console.error("Processing failed:", error);
   *   }
   * });
   */
  handleMessage(
    agentId: UUID,
    message: Partial<Memory> & {
      entityId: UUID;
      roomId: UUID;
      content: Content;
      worldId?: UUID;
    },
    options?: HandleMessageOptions,
  ): Promise<HandleMessageResult>;

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
