/** Replays provider-bound Qwen reasoning without exposing it as visible text. */
import type { GenerateTextContentPart } from "@elizaos/core";
import type { ModelMessage } from "ai";

export interface CerebrasReasoningPart extends GenerateTextContentPart {
  type: "reasoning";
  text: string;
  providerOptions: { cerebras: { model: string } };
}

export class CerebrasReasoningReplayError extends Error {
  readonly code = "CEREBRAS_REASONING_REPLAY_MISMATCH";
  constructor(message: string) {
    super(message);
    this.name = "CerebrasReasoningReplayError";
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isCerebrasReasoningPart(
  value: unknown,
  model: string
): value is CerebrasReasoningPart {
  const part = record(value);
  const binding = record(record(part?.providerOptions)?.cerebras);
  return part?.type === "reasoning" && typeof part.text === "string" && binding?.model === model;
}

/** The Chat Completions SDK retains this provider extension only in the raw body. */
export function cerebrasReasoningContent(body: unknown, model: string): CerebrasReasoningPart[] {
  const choices = record(body)?.choices;
  const message = Array.isArray(choices) ? record(record(choices[0])?.message) : undefined;
  const reasoning = message?.reasoning;
  return typeof reasoning === "string" && reasoning.length > 0
    ? [{ type: "reasoning", text: reasoning, providerOptions: { cerebras: { model } } }]
    : [];
}

export interface CerebrasReasoningReplay {
  model: string;
  assistants: Array<{ text: string; toolCallIds: string[]; reasoning?: string }>;
}

/** Keep the replay material in the caller's complete messages, never a hidden cache. */
export function cerebrasReasoningReplay(
  messages: ModelMessage[] | undefined,
  model: string
): CerebrasReasoningReplay | undefined {
  const assistants: CerebrasReasoningReplay["assistants"] = [];
  for (const message of messages ?? []) {
    if (message.role !== "assistant") continue;
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content;
    const reasoning = content
      .filter((part) => isCerebrasReasoningPart(part, model))
      .map((part) => part.text)
      .join("");
    assistants.push({
      text: content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
      toolCallIds: content
        .filter((part) => part.type === "tool-call")
        .map((part) => part.toolCallId),
      ...(reasoning ? { reasoning } : {}),
    });
  }
  return assistants.some((message) => message.reasoning !== undefined)
    ? { model, assistants }
    : undefined;
}

/** Reattach the supported `reasoning` field after the SDK's OpenAI-only serializer. */
export function applyCerebrasReasoningReplay(
  body: Record<string, unknown>,
  replay: CerebrasReasoningReplay
): void {
  const messages = Array.isArray(body.messages)
    ? body.messages.map(record).filter((message) => message?.role === "assistant")
    : [];
  if (body.model !== replay.model || messages.length !== replay.assistants.length) {
    throw new CerebrasReasoningReplayError(
      "Cerebras reasoning replay does not match the prepared assistant history"
    );
  }
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    const expected = replay.assistants[index];
    if (!message || !expected)
      throw new CerebrasReasoningReplayError(
        "Cerebras reasoning replay is missing an assistant message"
      );
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    const ids = calls.map((call) => record(call)?.id);
    if (
      (message.content ?? "") !== expected.text ||
      JSON.stringify(ids) !== JSON.stringify(expected.toolCallIds)
    ) {
      throw new CerebrasReasoningReplayError(
        "Cerebras reasoning replay assistant identity changed during serialization"
      );
    }
    if (expected.reasoning !== undefined) message.reasoning = expected.reasoning;
  }
}
