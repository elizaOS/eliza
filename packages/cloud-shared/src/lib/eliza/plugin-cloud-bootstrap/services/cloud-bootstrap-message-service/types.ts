/**
 * Internal types and constants for CloudBootstrapMessageService.
 *
 * Kept separate from the orchestration class so the helpers in this
 * subdirectory can share these definitions without re-importing the
 * class file.
 */

import type { Content, HandlerCallback, IAgentRuntime, Memory, State } from "@elizaos/core";
import type { NativePlannerActionResult, StrategyMode } from "../../types";

export type RuntimeWithEvaluators = IAgentRuntime & {
  evaluate?: (
    message: Memory,
    state: State,
    didRespond: boolean,
    callback: HandlerCallback,
    responseMessages: Memory[],
  ) => Promise<unknown>;
};

export interface MessageProcessingResult {
  didRespond: boolean;
  responseContent: Content | null;
  responseMessages: Memory[];
  state: State;
  mode: StrategyMode;
}

export interface ResponseDecision {
  shouldRespond: boolean;
  skipEvaluation: boolean;
  reason: string;
}

export type ScopedSettingOverride = {
  key: string;
  value: string;
};

export const EMPTY_STATE: State = { values: {}, data: {}, text: "" } as State;

export const SINGLE_SHOT_TEMPLATE = `task: Generate a response for {{agentName}}.

context:
{{providers}}

instructions:
Write a response for {{agentName}} based on the conversation.
Use available native tools only when the runtime exposes them through the planner path.

output:
JSON only. Return exactly one object:
{
  "thought": "short internal rationale",
  "actions": [],
  "text": "user-visible response"
}`;

export function isStateValue(value: unknown): value is NonNullable<State["values"][string]> {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint" ||
    typeof value === "object"
  );
}

export function getContentMetadata(content: Content): Record<string, unknown> {
  const metadata = content.metadata;
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

export function withActionResultsMetadata(
  message: Memory,
  actionResults: NativePlannerActionResult[],
): Memory {
  return {
    ...message,
    content: {
      ...message.content,
      metadata: {
        ...getContentMetadata(message.content),
        actionResults,
      },
      // Content has a strict index signature (ContentValue), but metadata holds
      // plugin-extension data. The cast is intentional: metadata is stored via
      // the Content index signature at runtime.
    } as unknown as Content,
  };
}
