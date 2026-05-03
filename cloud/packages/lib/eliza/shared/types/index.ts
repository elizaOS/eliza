/**
 * Shared Types for Eliza Plugin System
 */

import type { HandlerCallback, IAgentRuntime, Memory, UUID } from "@elizaos/core";

/**
 * Extended RUN_ENDED event payload that includes error status.
 * The base @elizaos/core type doesn't include "error" as a valid status,
 * but we need it for proper analytics tracking.
 */
export interface RunEndedEventPayload {
  runtime: IAgentRuntime;
  runId: UUID;
  messageId: UUID;
  roomId: UUID;
  entityId: UUID;
  startTime: number;
  status: "completed" | "error";
  endTime: number;
  duration: number;
  source: string;
  error?: string;
}

/**
 * Callback for streaming text chunks.
 * Called for each chunk of text as it's generated.
 * @param chunk - The text chunk
 * @param messageId - Optional message ID for coordination
 */
export type StreamChunkCallback = (chunk: string, messageId?: UUID) => Promise<void>;

/**
 * Callback for streaming reasoning/chain-of-thought.
 * Shows the LLM's planning process in real-time.
 * @param chunk - The reasoning text chunk
 * @param phase - Current phase of reasoning (planning, actions, response)
 * @param messageId - Optional message ID for coordination
 */
export type ReasoningChunkCallback = (
  chunk: string,
  phase: "planning" | "actions" | "response",
  messageId?: UUID,
) => Promise<void>;

/**
 * Parameters for message received handler.
 */
export interface MessageReceivedHandlerParams {
  runtime: IAgentRuntime;
  message: Memory;
  callback: HandlerCallback;
  /**
   * Optional callback for streaming text chunks in real-time.
   * When provided, the handler should stream the response chunk-by-chunk.
   */
  onStreamChunk?: StreamChunkCallback;
  /**
   * Optional callback for streaming reasoning/chain-of-thought.
   * When provided, shows the LLM's planning process to the user.
   */
  onReasoningChunk?: ReasoningChunkCallback;
}
