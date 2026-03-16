import type { Action, ActionResult, Content, Memory, State, UUID } from "@elizaos/core";

export interface MultiStepActionResult {
  data: { actionName: string };
  success: boolean;
  text?: string;
  error?: string | Error;
  values?: Record<string, unknown>;
}

export type StrategyMode = "simple" | "actions" | "none";

export interface StrategyResult {
  responseContent: Content | null;
  responseMessages: Memory[];
  state: State;
  mode: StrategyMode;
}

export interface ActionParameter {
  type: "string" | "number" | "boolean" | "object" | "array";
  description: string;
  required?: boolean;
}

export type ActionWithParams = Action & {
  parameters?: Record<string, ActionParameter>;
};

export interface ParsedMultiStepDecision {
  thought?: string;
  action?: string;
  parameters?: string | Record<string, unknown>;
  isFinish?: string | boolean;
}

export type StreamChunkCallback = (
  chunk: string,
  messageId?: UUID
) => Promise<void>;

export type ReasoningChunkCallback = (
  chunk: string,
  phase: "planning" | "actions" | "response" | "thinking",
  messageId?: UUID
) => Promise<void>;

export interface CloudMessageOptions {
  useMultiStep?: boolean;
  maxMultiStepIterations?: number;
  maxRetries?: number;
  onStreamChunk?: StreamChunkCallback;
  onReasoningChunk?: ReasoningChunkCallback;
  timeoutDuration?: number;
}
