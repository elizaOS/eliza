/**
 * Translates elizaOS message, tool, and tool-choice shapes into the AI SDK v6
 * contracts used by the stock Ollama adapter, rejecting malformed tools early.
 */

import type { ToolCall } from "@elizaos/core";
import { ElizaError, toWellFormedUnicode, truncateWellFormed } from "@elizaos/core";
import { jsonSchema, type ModelMessage, type ToolChoice, type ToolSet } from "ai";

type JsonObject = Record<string, unknown>;

function asRecord(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function optionalRecord(value: unknown): JsonObject | undefined {
  const row = asRecord(value);
  return Object.keys(row).length > 0 ? row : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch (error) {
    // error-policy:J3 message content is untrusted input; fail explicitly
    // rather than replacing a cyclic or unserializable prompt with fake text.
    throw new ElizaError("Ollama message content is not serializable", {
      code: "OLLAMA_INVALID_MESSAGE_CONTENT",
      cause: error,
      severity: "ephemeral",
    });
  }
}

function parseJsonOrText(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    // error-policy:J3 a tool may legitimately return plain text; keep that
    // explicit text shape instead of pretending it is parsed JSON.
    return value;
  }
}

function normalizeSchema(rawSchema: unknown): JsonObject {
  const schema = asRecord(rawSchema);
  if (Object.keys(schema).length === 0) {
    return { type: "object", properties: {} };
  }
  if (schema.type || schema.properties || schema.oneOf || schema.anyOf) {
    return schema;
  }
  if (schema.items && Object.keys(schema).length === 1) {
    return { type: "array", items: schema.items };
  }
  return { type: "object", properties: schema };
}

function isAiSdkSchema(value: unknown): boolean {
  if (typeof value === "function") return true;
  const schema = asRecord(value);
  return "~standard" in schema || ("jsonSchema" in schema && "validate" in schema);
}

/** Normalize existing AI SDK ToolSets or OpenAI-style tool arrays. */
export function normalizeNativeTools(tools: unknown): ToolSet | undefined {
  if (!tools) return undefined;
  if (!Array.isArray(tools)) {
    const existing = asRecord(tools);
    if (Object.keys(existing).length === 0) return undefined;
    const normalized: Record<string, unknown> = {};
    for (const [name, rawTool] of Object.entries(existing)) {
      const tool = asRecord(rawTool);
      const schema = tool.inputSchema ?? tool.parameters;
      if (schema === undefined) {
        throw new ElizaError(`Ollama native tool ${name} is missing an input schema`, {
          code: "OLLAMA_INVALID_TOOL_DEFINITION",
          context: { name },
          severity: "ephemeral",
        });
      }
      normalized[name] = {
        ...tool,
        inputSchema: isAiSdkSchema(schema) ? schema : jsonSchema(normalizeSchema(schema)),
      };
    }
    return normalized as ToolSet;
  }
  if (tools.length === 0) return undefined;

  const toolSet: Record<string, unknown> = {};
  for (const rawTool of tools) {
    const tool = asRecord(rawTool);
    const fn = asRecord(tool.function);
    const name = firstString(tool.name, fn.name);
    if (!name) {
      throw new ElizaError("Ollama native tool definition is missing a name", {
        code: "OLLAMA_INVALID_TOOL_DEFINITION",
        context: { tool: truncateWellFormed(toWellFormedUnicode(stringifyContent(rawTool)), 300) },
        severity: "ephemeral",
      });
    }
    const description = firstString(tool.description, fn.description);
    const schema = normalizeSchema(tool.inputSchema ?? tool.parameters ?? fn.parameters);
    toolSet[name] = {
      ...(description ? { description } : {}),
      inputSchema: jsonSchema(schema),
    };
  }
  return toolSet as ToolSet;
}

function normalizeAssistantContent(raw: JsonObject): ModelMessage["content"] {
  const content = stringifyContent(raw.content);
  const rawCalls = Array.isArray(raw.toolCalls) ? raw.toolCalls : [];
  const parts: unknown[] = [];
  if (content.length > 0) parts.push({ type: "text", text: content });
  for (const rawCall of rawCalls) {
    const call = asRecord(rawCall);
    const fn = asRecord(call.function);
    const toolName = firstString(call.toolName, call.name, fn.name);
    if (!toolName) continue;
    const toolCallId = firstString(call.toolCallId, call.id) ?? `call_${parts.length}`;
    parts.push({
      type: "tool-call",
      toolCallId,
      toolName,
      input: parseJsonOrText(call.input ?? call.arguments ?? fn.arguments ?? {}),
    });
  }
  return (parts.length > 0 ? parts : content) as ModelMessage["content"];
}

function normalizeToolContent(raw: JsonObject): ModelMessage["content"] {
  const toolCallId = firstString(raw.toolCallId, raw.id) ?? "unknown_tool_call";
  const toolName = firstString(raw.toolName, raw.name) ?? "unknown_tool";
  const value = parseJsonOrText(raw.content);
  const output = typeof value === "string" ? { type: "text", value } : { type: "json", value };
  return [
    {
      type: "tool-result",
      toolCallId,
      toolName,
      output,
    },
  ] as ModelMessage["content"];
}

/** Normalize mixed caller message shapes without dropping tool history. */
export function normalizeNativeMessages(messages: unknown): ModelMessage[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  return messages.map((message) => {
    const raw = asRecord(message);
    const providerOptions = optionalRecord(raw.providerOptions);
    if (raw.role === "system") {
      return {
        role: "system",
        content: stringifyContent(raw.content),
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
      content: stringifyContent(raw.content),
      ...(providerOptions ? { providerOptions } : {}),
    } as ModelMessage;
  });
}

/** Normalize string and OpenAI function-choice shapes for AI SDK v6. */
export function normalizeToolChoice(toolChoice: unknown): ToolChoice<ToolSet> | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") {
    return toolChoice;
  }
  const choice = asRecord(toolChoice);
  const fn = asRecord(choice.function);
  const toolName = firstString(choice.toolName, choice.name, fn.name);
  if (toolName) return { type: "tool", toolName };
  throw new ElizaError("Ollama toolChoice does not name a tool", {
    code: "OLLAMA_INVALID_TOOL_CHOICE",
    context: {
      toolChoice: truncateWellFormed(toWellFormedUnicode(stringifyContent(toolChoice)), 300),
    },
    severity: "ephemeral",
  });
}

/** Map AI SDK tool-call records back to the elizaOS public ToolCall contract. */
export function mapAiSdkToolCallsToCore(calls: unknown[] | undefined): ToolCall[] {
  if (!Array.isArray(calls)) return [];
  return calls.map((rawCall, index) => {
    const call = asRecord(rawCall);
    const fn = asRecord(call.function);
    const name = firstString(call.toolName, call.name, fn.name);
    if (!name) {
      throw new ElizaError("Ollama returned a tool call without a name", {
        code: "OLLAMA_INVALID_TOOL_CALL",
        context: { index },
        severity: "ephemeral",
      });
    }
    const id = firstString(call.toolCallId, call.id) ?? `call_${index}`;
    const parsed = parseJsonOrText(call.input ?? call.arguments ?? fn.arguments ?? {});
    const arguments_ =
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as ToolCall["arguments"])
        : typeof parsed === "string"
          ? parsed
          : ({ value: parsed } as unknown as ToolCall["arguments"]);
    return { id, name, arguments: arguments_ };
  });
}
