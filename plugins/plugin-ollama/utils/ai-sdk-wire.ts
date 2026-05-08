/**
 * AI SDK wiring for Ollama text generation (`models/text.ts`).
 *
 * ## Why this module is separate
 *
 * Eliza’s `GenerateTextParams` carry **`messages`**, **`tools`**, and **`toolChoice`** in loose
 * shapes (protobuf-era typing, plus `unknown` extensions). The Vercel **`generateText`** and
 * **`streamText`** APIs expect **`ModelMessage[]`**, **`ToolSet`**, and **`ToolChoice<ToolSet>`**
 * on the native path. Isolating the
 * translation here keeps `text.ts` focused on orchestration and matches how **`plugin-openai`**
 * structures the same problem—without pulling Cerebras-only schema/name sanitization into
 * Ollama (local models do not share that grammar compiler).
 *
 * ## Exported helpers
 *
 * - **`normalizeNativeTools`** — Array → `ToolSet` with `jsonSchema(...)`; object → pass-through
 *   so advanced callers can supply a pre-built `ToolSet`. **Why both:** core usually sends
 *   `ToolDefinition[]`, but tests and future code paths may send an SDK-native object.
 * - **`normalizeNativeMessages`** — Maps Eliza/chat-shaped records into `ModelMessage[]` so
 *   assistant tool calls and tool results round-trip. **Why:** v5 Stage 1 is not a single flat
 *   `prompt` string; dropping this step would flatten or drop tool history incorrectly.
 * - **`normalizeToolChoice`** — Accepts string enums and object-shaped choices from core.
 * - **`parseJsonIfPossible`** — Best-effort JSON parse for string tool arguments; returns
 *   non-strings unchanged so **`null` / objects** are not coerced to `""` (which would confuse
 *   downstream argument parsers).
 * - **`mapAiSdkToolCallsToCore`** — Renames AI SDK fields (`toolCallId`, `toolName`, `input`)
 *   into Eliza **`ToolCall`** (`id`, `name`, `arguments`) so `parseMessageHandlerNativeToolCall`
 *   and trajectory export see one consistent shape across providers.
 */

import type { JsonValue, ToolCall } from "@elizaos/core";
import {
  type JSONSchema7,
  jsonSchema,
  type ModelMessage,
  type ToolChoice,
  type ToolSet,
  type UserContent,
} from "ai";

/** Converts Eliza `ToolDefinition[]` or an AI SDK `ToolSet` into the shape `generateText` expects. */
export function normalizeNativeTools(tools: unknown): ToolSet | undefined {
  if (!tools) {
    return undefined;
  }

  if (!Array.isArray(tools)) {
    return tools as ToolSet;
  }

  const toolSet: Record<string, unknown> = {};

  for (const rawTool of tools) {
    const tool = asRecord(rawTool);
    const functionTool = asRecord(tool.function);
    const name = firstString(tool.name, functionTool.name);

    if (!name) {
      throw new Error("[Ollama] Native tool definition is missing a name.");
    }

    const description = firstString(tool.description, functionTool.description);
    const rawSchema =
      tool.parameters ?? functionTool.parameters ?? ({ type: "object" } satisfies JSONSchema7);
    const inputSchema = sanitizeJsonSchema(rawSchema, true);

    toolSet[name] = {
      ...(description ? { description } : {}),
      inputSchema: jsonSchema(inputSchema as JSONSchema7),
    };
  }

  return Object.keys(toolSet).length > 0 ? (toolSet as ToolSet) : undefined;
}

/** Converts Eliza `ChatMessage[]`-like rows into `ModelMessage[]` for `generateText({ messages })`. */
export function normalizeNativeMessages(messages: unknown): ModelMessage[] | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }

  return messages.map((message) => normalizeNativeMessage(message));
}

/** Maps core / OpenAI-style tool choice objects onto AI SDK `ToolChoice`. */
export function normalizeToolChoice(toolChoice: unknown): ToolChoice<ToolSet> | undefined {
  if (!toolChoice) {
    return undefined;
  }

  if (
    typeof toolChoice === "string" &&
    (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required")
  ) {
    return toolChoice;
  }

  const choice = asRecord(toolChoice);
  if (choice.type === "tool") {
    if (typeof choice.toolName === "string" && choice.toolName.length > 0) {
      return toolChoice as ToolChoice<ToolSet>;
    }
    const toolName = firstString(choice.toolName, choice.name);
    if (toolName) {
      return { type: "tool", toolName };
    }
  }

  if (choice.type === "function") {
    const fn = asRecord(choice.function);
    const toolName = firstString(fn.name);
    if (toolName) {
      return { type: "tool", toolName };
    }
  }

  const namedTool = firstString(choice.name);
  if (namedTool) {
    return { type: "tool", toolName: namedTool };
  }

  return toolChoice as ToolChoice<ToolSet>;
}

/** Parses JSON strings; returns non-strings unchanged (including `null` / `undefined`). */
export function parseJsonIfPossible(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Maps AI SDK `generateText` tool call entries to Eliza `ToolCall` records for core parsers. */
export function mapAiSdkToolCallsToCore(toolCalls: unknown[] | undefined): ToolCall[] {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return [];
  }

  const out: ToolCall[] = [];
  for (const tc of toolCalls) {
    const mapped = mapOneToolCall(tc);
    if (mapped) {
      out.push(mapped);
    }
  }
  return out;
}

function mapOneToolCall(tc: unknown): ToolCall | null {
  const r = asRecord(tc);
  const id = String(firstString(r.toolCallId, r.id) ?? "");
  const name = String(firstString(r.toolName, r.name) ?? "").trim();
  if (!name) {
    return null;
  }

  const rawInput = r.input ?? r.arguments ?? r.args;
  let args: Record<string, JsonValue> | string;
  if (typeof rawInput === "string") {
    const parsed = parseJsonIfPossible(rawInput);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      args = parsed as Record<string, JsonValue>;
    } else {
      args = rawInput;
    }
  } else if (rawInput && typeof rawInput === "object" && !Array.isArray(rawInput)) {
    args = rawInput as Record<string, JsonValue>;
  } else {
    args = {};
  }

  return { id, name, arguments: args };
}

function normalizeNativeMessage(message: unknown): ModelMessage {
  const raw = asRecord(message);
  const providerOptions = asOptionalRecord(raw.providerOptions);

  if (raw.role === "system") {
    return {
      role: "system",
      content: stringifyMessageContent(raw.content),
      ...(providerOptions ? { providerOptions } : {}),
    } as ModelMessage;
  }

  if (raw.role === "assistant") {
    return {
      role: "assistant",
      content: normalizeAssistantContent(raw),
      ...(providerOptions ? { providerOptions } : {}),
    } as ModelMessage;
  }

  if (raw.role === "tool") {
    return {
      role: "tool",
      content: normalizeToolContent(raw),
      ...(providerOptions ? { providerOptions } : {}),
    } as ModelMessage;
  }

  return {
    role: "user",
    content: normalizeUserContent(raw.content),
    ...(providerOptions ? { providerOptions } : {}),
  } as ModelMessage;
}

function normalizeAssistantContent(message: Record<string, unknown>): unknown {
  const toolCalls = Array.isArray(message.toolCalls) ? message.toolCalls : [];

  if (toolCalls.length === 0) {
    if (Array.isArray(message.content) || typeof message.content === "string") {
      return message.content;
    }
    return "";
  }

  const parts: unknown[] = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    parts.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    parts.push(...message.content);
  }

  for (const toolCall of toolCalls) {
    const rawCall = asRecord(toolCall);
    const rawFunction = asRecord(rawCall.function);
    const toolCallId = firstString(rawCall.toolCallId, rawCall.id);
    const toolName = firstString(rawCall.toolName, rawCall.name, rawFunction.name);

    if (!toolCallId || !toolName) {
      continue;
    }

    parts.push({
      type: "tool-call",
      toolCallId,
      toolName,
      input: parseToolCallInput(rawCall, rawFunction),
    });
  }

  return parts;
}

function normalizeToolContent(message: Record<string, unknown>): unknown[] {
  if (Array.isArray(message.content)) {
    return message.content;
  }

  const toolCallId = firstString(message.toolCallId, message.id) ?? "tool-call";
  const toolName = firstString(message.toolName, message.name) ?? "tool";
  const parsed = parseJsonIfPossible(message.content);

  return [
    {
      type: "tool-result",
      toolCallId,
      toolName,
      output:
        typeof parsed === "string"
          ? { type: "text", value: parsed }
          : { type: "json", value: parsed },
    },
  ];
}

function normalizeUserContent(content: unknown): UserContent {
  if (Array.isArray(content)) {
    return content as UserContent;
  }
  return stringifyMessageContent(content);
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content == null) {
    return "";
  }
  return typeof content === "object" ? JSON.stringify(content) : String(content);
}

function parseToolCallInput(
  rawCall: Record<string, unknown>,
  rawFunction: Record<string, unknown>
): unknown {
  if ("input" in rawCall) {
    return rawCall.input;
  }
  return parseJsonIfPossible(rawCall.arguments ?? rawFunction.arguments ?? {});
}

function sanitizeJsonSchema(schema: unknown, isRoot = false): JSONSchema7 {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object" };
  }

  const record = schema as Record<string, unknown>;
  const sanitized: Record<string, unknown> = { ...record };

  if (typeof sanitized.type !== "string") {
    const inferredType = inferJsonSchemaType(sanitized, isRoot);
    if (inferredType) {
      sanitized.type = inferredType;
    }
  }

  if (
    sanitized.properties &&
    typeof sanitized.properties === "object" &&
    !Array.isArray(sanitized.properties)
  ) {
    const properties: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(sanitized.properties as Record<string, unknown>)) {
      properties[key] = sanitizeJsonSchema(value);
    }
    sanitized.properties = properties;
  }

  if (sanitized.items) {
    sanitized.items = Array.isArray(sanitized.items)
      ? sanitized.items.map((item) => sanitizeJsonSchema(item))
      : sanitizeJsonSchema(sanitized.items);
  }

  for (const unionKey of ["anyOf", "oneOf", "allOf"] as const) {
    const value = sanitized[unionKey];
    if (Array.isArray(value)) {
      sanitized[unionKey] = value.map((item) => sanitizeJsonSchema(item));
    }
  }

  return sanitized as JSONSchema7;
}

function inferJsonSchemaType(schema: Record<string, unknown>, isRoot: boolean): string | undefined {
  if (
    "properties" in schema ||
    "required" in schema ||
    "additionalProperties" in schema ||
    isRoot
  ) {
    return "object";
  }
  if ("items" in schema) {
    return "array";
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const types = new Set(schema.enum.map((value) => typeof value));
    if (types.size === 1) {
      const [type] = [...types];
      if (type === "string" || type === "number" || type === "boolean") {
        return type;
      }
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }
  return undefined;
}
