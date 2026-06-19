import type { Action, ActionResult, Content, Memory, State, UUID } from "@elizaos/core";

export interface NativePlannerActionResult extends ActionResult {
  data: NonNullable<ActionResult["data"]> & { actionName: string };
  text?: string;
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
  enum?: string[] | number[];
  default?: unknown;
}

export type ActionWithParams = Action;

export function defineActionParameters(
  parameters?: Record<string, ActionParameter> | Action["parameters"],
): Action["parameters"] {
  if (!parameters) {
    return undefined;
  }

  if (Array.isArray(parameters)) {
    return parameters;
  }

  const entries = Object.entries(parameters);
  if (entries.length === 0) {
    return undefined;
  }

  return entries.map(([name, parameter]) => ({
    name,
    description: parameter.description,
    required: parameter.required,
    schema: {
      type: parameter.type,
      default: parameter.default ?? undefined,
      enum: parameter.enum?.map((value: string | number) => String(value)),
      enumValues: parameter.enum?.map((value: string | number) => String(value)),
    },
  })) as Action["parameters"];
}

export interface ParsedNativePlannerDecision {
  thought?: string;
  action?: string;
  parameters?: string | Record<string, unknown>;
  isFinish?: string | boolean;
}

export type StreamChunkCallback = (chunk: string, messageId?: UUID) => Promise<void>;

export type ReasoningChunkCallback = (
  chunk: string,
  phase: "planning" | "actions" | "response" | "thinking",
  messageId?: UUID,
) => Promise<void>;

/** Actions whose successful results should NOT appear in # Previous Action Results.
 *  Their side-effects (e.g., registering new actions) are sufficient context. */
export const TRANSPARENT_META_ACTIONS = new Set(["SEARCH_ACTIONS"]);

export interface CloudMessageOptions {
  useNativePlanner?: boolean;
  maxNativePlannerIterations?: number;
  maxRetries?: number;
  onStreamChunk?: StreamChunkCallback;
  onReasoningChunk?: ReasoningChunkCallback;
  timeoutDuration?: number;
}
