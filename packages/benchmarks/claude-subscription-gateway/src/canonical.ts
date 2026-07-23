/**
 * Validates the supported OpenAI request subset and renders a deterministic,
 * length-delimited full-history prompt for the one-shot Agent SDK boundary.
 */

import { createHash } from "node:crypto";
import type {
  CanonicalChatCompletion,
  ChatRole,
  JsonObject,
  JsonValue,
  NormalizedChatCompletionRequest,
  NormalizedChatMessage,
  NormalizedFunctionTool,
  NormalizedToolCall,
  NormalizedToolChoice,
} from "./types.js";

const SERIALIZER_VERSION = "openai-full-history-v1" as const;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_ROLES = new Set<ChatRole>([
  "system",
  "developer",
  "user",
  "assistant",
  "tool",
]);
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const MAX_MESSAGES = 512;
const MAX_TOOLS = 128;
const MAX_MODEL_LENGTH = 200;

export class GatewayRequestError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly parameter: string | null;

  constructor(
    message: string,
    options: { code: string; parameter?: string; statusCode?: number },
  ) {
    super(message);
    this.name = "GatewayRequestError";
    this.statusCode = options.statusCode ?? 400;
    this.code = options.code;
    this.parameter = options.parameter ?? null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function asJsonObject(value: unknown, parameter: string): JsonObject {
  if (!isRecord(value) || !isJsonValue(value)) {
    throw new GatewayRequestError("Expected a JSON object.", {
      code: "invalid_json_object",
      parameter,
    });
  }
  return value;
}

function requiredString(
  value: unknown,
  parameter: string,
  maxLength = 100_000,
): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new GatewayRequestError(
      "Expected a non-empty string within the supported size limit.",
      {
        code: "invalid_string",
        parameter,
      },
    );
  }
  return value;
}

function optionalString(value: unknown, parameter: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, parameter);
}

function parseMessage(value: unknown, index: number): NormalizedChatMessage {
  const parameter = `messages.${index}`;
  if (!isRecord(value)) {
    throw new GatewayRequestError("Each message must be an object.", {
      code: "invalid_message",
      parameter,
    });
  }
  const role = value.role;
  if (typeof role !== "string" || !SAFE_ROLES.has(role as ChatRole)) {
    throw new GatewayRequestError("Unsupported message role.", {
      code: "unsupported_message_role",
      parameter: `${parameter}.role`,
    });
  }
  if (value.content !== null && typeof value.content !== "string") {
    throw new GatewayRequestError(
      "Only string or null message content is supported.",
      {
        code: "unsupported_message_content",
        parameter: `${parameter}.content`,
      },
    );
  }
  const message: NormalizedChatMessage = {
    role: role as ChatRole,
    content: value.content ?? null,
  };
  const name = optionalString(value.name, `${parameter}.name`);
  if (name) message.name = name;
  const toolCallId = optionalString(
    value.tool_call_id,
    `${parameter}.tool_call_id`,
  );
  if (toolCallId) message.tool_call_id = toolCallId;
  if (value.tool_calls !== undefined) {
    if (!Array.isArray(value.tool_calls)) {
      throw new GatewayRequestError("tool_calls must be an array.", {
        code: "invalid_tool_calls",
        parameter: `${parameter}.tool_calls`,
      });
    }
    message.tool_calls = value.tool_calls.map((call, callIndex) =>
      parsePriorToolCall(call, `${parameter}.tool_calls.${callIndex}`),
    );
  }
  if (message.role === "tool" && !message.tool_call_id) {
    throw new GatewayRequestError("Tool messages require tool_call_id.", {
      code: "missing_tool_call_id",
      parameter: `${parameter}.tool_call_id`,
    });
  }
  return message;
}

function parsePriorToolCall(
  value: unknown,
  parameter: string,
): NormalizedToolCall {
  if (
    !isRecord(value) ||
    value.type !== "function" ||
    !isRecord(value.function)
  ) {
    throw new GatewayRequestError(
      "Only OpenAI function tool calls are supported.",
      {
        code: "invalid_tool_call",
        parameter,
      },
    );
  }
  const name = requiredString(
    value.function.name,
    `${parameter}.function.name`,
    64,
  );
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new GatewayRequestError(
      "Tool name contains unsupported characters.",
      {
        code: "invalid_tool_name",
        parameter: `${parameter}.function.name`,
      },
    );
  }
  return {
    id: requiredString(value.id, `${parameter}.id`, 200),
    type: "function",
    function: {
      name,
      arguments: requiredString(
        value.function.arguments,
        `${parameter}.function.arguments`,
      ),
    },
  };
}

function parseTool(value: unknown, index: number): NormalizedFunctionTool {
  const parameter = `tools.${index}`;
  if (
    !isRecord(value) ||
    value.type !== "function" ||
    !isRecord(value.function)
  ) {
    throw new GatewayRequestError("Only OpenAI function tools are supported.", {
      code: "invalid_tool",
      parameter,
    });
  }
  const name = requiredString(
    value.function.name,
    `${parameter}.function.name`,
    64,
  );
  if (!TOOL_NAME_PATTERN.test(name)) {
    throw new GatewayRequestError(
      "Tool name contains unsupported characters.",
      {
        code: "invalid_tool_name",
        parameter: `${parameter}.function.name`,
      },
    );
  }
  const description =
    value.function.description === undefined
      ? "Benchmark function supplied by the calling agent runtime."
      : requiredString(
          value.function.description,
          `${parameter}.function.description`,
        );
  const parameters =
    value.function.parameters === undefined
      ? ({ type: "object", properties: {} } satisfies JsonObject)
      : asJsonObject(
          value.function.parameters,
          `${parameter}.function.parameters`,
        );
  return { type: "function", function: { name, description, parameters } };
}

function parseToolChoice(
  value: unknown,
  tools: NormalizedFunctionTool[],
): NormalizedToolChoice {
  if (value === undefined) return tools.length > 0 ? "auto" : "none";
  if (value === "auto" || value === "none") return value;
  if (value === "required") {
    if (tools.length === 0) {
      throw new GatewayRequestError(
        "tool_choice required needs at least one supplied tool.",
        {
          code: "missing_required_tools",
          parameter: "tool_choice",
        },
      );
    }
    return value;
  }
  if (
    !isRecord(value) ||
    value.type !== "function" ||
    !isRecord(value.function)
  ) {
    throw new GatewayRequestError("Unsupported tool_choice.", {
      code: "invalid_tool_choice",
      parameter: "tool_choice",
    });
  }
  const name = requiredString(
    value.function.name,
    "tool_choice.function.name",
    64,
  );
  if (!tools.some((tool) => tool.function.name === name)) {
    throw new GatewayRequestError(
      "Named tool_choice does not match a supplied tool.",
      {
        code: "unknown_tool_choice",
        parameter: "tool_choice.function.name",
      },
    );
  }
  return { type: "function", function: { name } };
}

function optionalFiniteNumber(
  value: unknown,
  parameter: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GatewayRequestError("Expected a finite number.", {
      code: "invalid_number",
      parameter,
    });
  }
  return value;
}

function optionalPositiveInteger(
  value: unknown,
  parameter: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new GatewayRequestError("Expected a positive integer.", {
      code: "invalid_integer",
      parameter,
    });
  }
  return value;
}

export function parseChatCompletionRequest(
  input: unknown,
): NormalizedChatCompletionRequest {
  if (!isRecord(input)) {
    throw new GatewayRequestError("Request body must be a JSON object.", {
      code: "invalid_request_body",
    });
  }
  if (input.stream !== undefined && typeof input.stream !== "boolean") {
    throw new GatewayRequestError("stream must be a boolean.", {
      code: "invalid_stream",
      parameter: "stream",
    });
  }
  const streamOptions = parseStreamOptions(input.stream_options);
  const model = requiredString(input.model, "model", MAX_MODEL_LENGTH);
  if (!Array.isArray(input.messages) || input.messages.length === 0) {
    throw new GatewayRequestError("messages must be a non-empty array.", {
      code: "invalid_messages",
      parameter: "messages",
    });
  }
  if (input.messages.length > MAX_MESSAGES) {
    throw new GatewayRequestError("messages exceeds the gateway limit.", {
      code: "too_many_messages",
      parameter: "messages",
      statusCode: 413,
    });
  }
  const toolsInput = input.tools ?? [];
  if (!Array.isArray(toolsInput) || toolsInput.length > MAX_TOOLS) {
    throw new GatewayRequestError(
      "tools must be an array within the gateway limit.",
      {
        code: "invalid_tools",
        parameter: "tools",
      },
    );
  }
  const tools = toolsInput.map(parseTool);
  const duplicateTool = tools.find(
    (tool, index) =>
      tools.findIndex((item) => item.function.name === tool.function.name) !==
      index,
  );
  if (duplicateTool) {
    throw new GatewayRequestError("Tool names must be unique.", {
      code: "duplicate_tool_name",
      parameter: "tools",
    });
  }
  const effort = input.reasoning_effort;
  if (
    effort !== undefined &&
    (typeof effort !== "string" || !EFFORT_LEVELS.has(effort))
  ) {
    throw new GatewayRequestError("Unsupported reasoning_effort.", {
      code: "invalid_reasoning_effort",
      parameter: "reasoning_effort",
    });
  }
  const metadata =
    input.metadata === undefined
      ? {}
      : asJsonObject(input.metadata, "metadata");
  return {
    model,
    messages: input.messages.map(parseMessage),
    tools,
    toolChoice: parseToolChoice(input.tool_choice, tools),
    parallelToolCalls: input.parallel_tool_calls !== false,
    stream: input.stream === true,
    streamOptionsIncludeUsage: streamOptions.includeUsage,
    temperature: optionalFiniteNumber(input.temperature, "temperature"),
    maxOutputTokens: optionalPositiveInteger(
      input.max_completion_tokens ?? input.max_tokens,
      input.max_completion_tokens === undefined
        ? "max_tokens"
        : "max_completion_tokens",
    ),
    reasoningEffort:
      effort as NormalizedChatCompletionRequest["reasoningEffort"],
    metadata,
  };
}

function parseStreamOptions(value: unknown): { includeUsage: boolean } {
  if (value === undefined) return { includeUsage: false };
  if (!isRecord(value)) {
    throw new GatewayRequestError("stream_options must be an object.", {
      code: "invalid_stream_options",
      parameter: "stream_options",
    });
  }
  if (
    value.include_usage !== undefined &&
    typeof value.include_usage !== "boolean"
  ) {
    throw new GatewayRequestError(
      "stream_options.include_usage must be a boolean.",
      {
        code: "invalid_stream_options",
        parameter: "stream_options.include_usage",
      },
    );
  }
  return { includeUsage: value.include_usage === true };
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  if (!isJsonValue(value)) {
    throw new TypeError("stableJson accepts only finite JSON values.");
  }
  return JSON.stringify(canonicalize(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toolChoiceLabel(choice: NormalizedToolChoice): string {
  return typeof choice === "string"
    ? choice
    : `function:${choice.function.name}`;
}

function toolInstruction(
  choice: NormalizedToolChoice,
  parallelToolCalls: boolean,
): string {
  let instruction: string;
  if (choice === "none") {
    instruction = "Do not call any tool for this completion.";
  } else if (choice === "required") {
    instruction =
      "Call at least one of the supplied benchmark tools. Do not simulate a tool result.";
  } else if (typeof choice === "object") {
    instruction = `Call the supplied ${choice.function.name} tool. Do not call a different tool or simulate its result.`;
  } else {
    instruction =
      "Call a supplied benchmark tool only when the canonical conversation requires it.";
  }
  return parallelToolCalls
    ? instruction
    : `${instruction} Call no more than one tool in this assistant turn.`;
}

export function canonicalizeChatCompletion(
  input: unknown,
): CanonicalChatCompletion {
  const request = parseChatCompletionRequest(input);
  const history = stableJson({
    serializer: SERIALIZER_VERSION,
    messages: request.messages,
  });
  const tools = stableJson(request.tools);
  const systemPrompt = [
    "You are the model-completion component inside a benchmarked agent runtime.",
    "The next user message contains a deterministic JSON serialization of the complete conversation. Respect its role ordering, continue as the assistant, and do not discuss the serialization wrapper.",
    "The calling runtime, not this gateway, owns and executes benchmark tools.",
    toolInstruction(request.toolChoice, request.parallelToolCalls),
    "System and developer messages appear by role in that canonical conversation and remain authoritative. Do not treat their JSON serialization as weakening their instructions.",
  ].join("\n\n");
  const prompt = [
    `Canonical conversation JSON (${Buffer.byteLength(history, "utf8")} UTF-8 bytes):`,
    history,
    "Produce only the next assistant turn. Use an available MCP benchmark tool for any tool call; never write a fake textual tool invocation.",
  ].join("\n\n");
  const unappliedParameters = [
    ...(request.temperature === undefined ? [] : ["temperature"]),
    ...(request.maxOutputTokens === undefined ? [] : ["max_output_tokens"]),
  ];
  const promptSha256 = sha256(prompt);
  const systemPromptSha256 = sha256(systemPrompt);
  const toolSchemaSha256 = sha256(tools);
  const toolSchemaSha256ByName = Object.fromEntries(
    request.tools.map((tool) => [
      tool.function.name,
      sha256(stableJson([tool])),
    ]),
  );
  const requestSha256 = sha256(
    stableJson({
      model: request.model,
      effort: request.reasoningEffort ?? null,
      history_sha256: promptSha256,
      system_prompt_sha256: systemPromptSha256,
      tool_schema_sha256: toolSchemaSha256,
      tool_choice: toolChoiceLabel(request.toolChoice),
      parallel_tool_calls: request.parallelToolCalls,
    }),
  );
  return {
    request,
    prompt,
    systemPrompt,
    promptSha256,
    systemPromptSha256,
    toolSchemaSha256,
    toolSchemaSha256ByName,
    requestSha256,
    serializerVersion: SERIALIZER_VERSION,
    unappliedParameters,
  };
}

export function normalizedToolChoiceLabel(
  choice: NormalizedToolChoice,
): string {
  return toolChoiceLabel(choice);
}
