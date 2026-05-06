/**
 * Shared backend types for the native-reasoning loop.
 *
 * The loop talks to backends via `ReasoningBackend.callTurn(...)` using a
 * unified message/tool/result schema (this file). Concrete backends translate
 * these types to/from their own wire format.
 *
 * The Anthropic backend maps this shape almost 1:1 to Anthropic content
 * blocks. Other backends adapt the same loop contract to their own wire
 * formats.
 */

import type { NativeTool } from "../tool-schema.js";

/** A text segment emitted by the model (assistant) or by the user. */
export interface TextBlock {
  type: "text";
  text: string;
}

/** Model-issued tool invocation. `input` is the parsed JSON arguments. */
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/** Tool result fed back into the next turn under role:"tool" (or user). */
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type TurnContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/**
 * Unified message format. `role:"tool"` carries `tool_result` blocks; the
 * Anthropic adapter rewrites these as `role:"user"` on the wire (Anthropic
 * doesn't have a distinct tool role), but keeping a separate role here
 * keeps backend adapters simple.
 */
export interface TurnMessage {
  role: "user" | "assistant" | "tool";
  content: TurnContentBlock[];
}

/** Tool call extracted from a turn result. Loop dispatches handlers off this. */
export interface ToolCallRequest {
  id: string;
  name: string;
  input: unknown;
}

/** Result of a single backend turn — what the model produced. */
export interface TurnResult {
  /** Concatenated text content. May be empty if the turn was tool-use only. */
  text: string;
  /** All `tool_use` blocks the model emitted, in order. */
  toolCalls: ToolCallRequest[];
  /** Backend-reported stop reason (for diagnostics). */
  stopReason?: string;
  /** Token usage if the backend reports it. */
  usage?: { input: number; output: number };
  /**
   * The raw content blocks the model emitted, preserved so we can echo the
   * assistant turn back into history with the original block ordering. The
   * loop is the canonical owner of `messages` history.
   */
  rawAssistantBlocks: Array<TextBlock | ToolUseBlock>;
}

export interface CallTurnOptions {
  systemPrompt: string;
  messages: TurnMessage[];
  tools: NativeTool[];
  abortSignal?: AbortSignal;
}

/** A reasoning backend: takes a unified turn request, returns a result. */
export interface ReasoningBackend {
  /** Stable name of the backend. */
  readonly name: string;
  callTurn(opts: CallTurnOptions): Promise<TurnResult>;
}
