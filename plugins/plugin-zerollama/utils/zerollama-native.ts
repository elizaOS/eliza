/**
 * Native zerollama HTTP client for `/api/chat` and `/api/embed`.
 *
 * Bypasses `ollama-ai-provider-v2` / AI SDK because that stack emits OpenAI-ish
 * top-level fields (`temperature`, `max_output_tokens`, `tool_choice`) that
 * zerollama rejects (`unknown field`, HTTP 400). Wire shape matches zerollama
 * OpenAPI `ChatRequest` / `EmbedRequest`: sampling under `options`, tools
 * without `tool_choice`.
 */

import type { GenerateTextResult, TextStreamResult, TokenUsage, ToolCall } from "@elizaos/core";
import type { ModelMessage, ToolSet } from "ai";
import { estimateUsage } from "./modelUsage";

export type ZerollamaChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id?: string;
    function: { name: string; arguments: Record<string, unknown> | string };
  }>;
};

export type ZerollamaChatOptions = {
  temperature?: number;
  top_p?: number;
  num_predict?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
};

export type ZerollamaChatRequest = {
  model: string;
  messages: ZerollamaChatMessage[];
  stream?: boolean;
  think?: boolean;
  tools?: unknown[];
  format?: string | Record<string, unknown>;
  options?: ZerollamaChatOptions;
  keep_alive?: string | number;
};

type ChatStreamEvent = {
  message?: {
    role?: string;
    content?: string;
    tool_calls?: unknown[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function contentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content == null) return "";
    return typeof content === "object" ? JSON.stringify(content) : String(content);
  }
  const parts: string[] = [];
  for (const part of content) {
    const row = asRecord(part);
    if (typeof row.text === "string") parts.push(row.text);
    else if (typeof part === "string") parts.push(part);
  }
  return parts.join("");
}

function parseToolArguments(value: unknown): Record<string, unknown> | string {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return asRecord(parsed);
    } catch {
      // error-policy:J3 tool arguments may be either JSON or an explicit raw
      // string under the public ToolCall contract.
      return value;
    }
  }
  if (value && typeof value === "object") {
    return asRecord(value);
  }
  return {};
}

/** Convert AI SDK / Eliza-normalized messages into zerollama `ChatMessage`s. */
export function toZerollamaChatMessages(args: {
  messages?: ModelMessage[] | null;
  system?: string | null;
  prompt?: string | null;
}): ZerollamaChatMessage[] {
  const out: ZerollamaChatMessage[] = [];
  if (args.system?.trim()) {
    out.push({ role: "system", content: args.system });
  }

  const messages = args.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    const prompt = args.prompt?.trim() ?? "";
    if (prompt) out.push({ role: "user", content: prompt });
    return out;
  }

  for (const message of messages) {
    const row = asRecord(message);
    const role = firstString(row.role) ?? "user";

    if (role === "system") {
      const text = contentToString(row.content);
      if (text) out.push({ role: "system", content: text });
      continue;
    }

    if (role === "assistant") {
      const toolCallsRaw = Array.isArray(row.toolCalls)
        ? row.toolCalls
        : Array.isArray(row.content)
          ? (row.content as unknown[]).filter((part) => asRecord(part).type === "tool-call")
          : [];
      const tool_calls = toolCallsRaw
        .map((call) => {
          const c = asRecord(call);
          const fn = asRecord(c.function);
          const name = firstString(c.toolName, c.name, fn.name);
          if (!name) return null;
          const id = firstString(c.toolCallId, c.id);
          const argsValue = c.input ?? c.arguments ?? fn.arguments ?? {};
          return {
            ...(id ? { id } : {}),
            function: {
              name,
              arguments: parseToolArguments(argsValue),
            },
          };
        })
        .filter((call): call is NonNullable<typeof call> => call != null);

      out.push({
        role: "assistant",
        content: contentToString(
          Array.isArray(row.content)
            ? (row.content as unknown[]).filter((part) => asRecord(part).type !== "tool-call")
            : row.content
        ),
        ...(tool_calls.length > 0 ? { tool_calls } : {}),
      });
      continue;
    }

    if (role === "tool") {
      out.push({
        role: "tool",
        content: contentToString(row.content),
      });
      continue;
    }

    out.push({
      role: "user",
      content: contentToString(row.content),
    });
  }

  return out;
}

/** Map an AI SDK `ToolSet` (or similar) onto zerollama `ToolDefinition[]`. */
export function toZerollamaTools(tools: ToolSet | undefined): unknown[] | undefined {
  if (!tools || typeof tools !== "object") return undefined;
  const out: unknown[] = [];
  for (const [name, rawTool] of Object.entries(tools)) {
    const tool = asRecord(rawTool);
    const description = typeof tool.description === "string" ? tool.description : undefined;
    const schemaHolder = tool.inputSchema ?? tool.parameters;
    let parameters: Record<string, unknown> = { type: "object", properties: {} };
    if (schemaHolder && typeof schemaHolder === "object") {
      const holder = asRecord(schemaHolder);
      if (holder.jsonSchema && typeof holder.jsonSchema === "object") {
        parameters = asRecord(holder.jsonSchema);
      } else if (holder.type || holder.properties) {
        parameters = holder;
      }
    }
    out.push({
      type: "function",
      function: {
        name,
        ...(description ? { description } : {}),
        parameters,
      },
    });
  }
  return out.length > 0 ? out : undefined;
}

export function buildZerollamaChatBody(args: {
  model: string;
  messages: ZerollamaChatMessage[];
  stream: boolean;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  tools?: unknown[];
  format?: string | Record<string, unknown>;
}): ZerollamaChatRequest {
  const options: ZerollamaChatOptions = {};
  if (typeof args.temperature === "number") options.temperature = args.temperature;
  if (typeof args.topP === "number") options.top_p = args.topP;
  if (typeof args.maxTokens === "number") options.num_predict = args.maxTokens;
  if (typeof args.frequencyPenalty === "number") {
    options.frequency_penalty = args.frequencyPenalty;
  }
  if (typeof args.presencePenalty === "number") {
    options.presence_penalty = args.presencePenalty;
  }

  return {
    model: args.model,
    messages: args.messages,
    stream: args.stream,
    think: false,
    ...(args.tools && args.tools.length > 0 ? { tools: args.tools } : {}),
    ...(args.format ? { format: args.format } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

function mapWireToolCalls(raw: unknown[] | undefined): ToolCall[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: ToolCall[] = [];
  for (const [index, item] of raw.entries()) {
    const row = asRecord(item);
    const fn = asRecord(row.function);
    const name = firstString(fn.name, row.name);
    if (!name) continue;
    const id = firstString(row.id, row.toolCallId) ?? `call_${index}`;
    const argsValue = fn.arguments ?? row.arguments ?? {};
    const parsed =
      typeof argsValue === "string"
        ? (() => {
            try {
              return JSON.parse(argsValue) as unknown;
            } catch {
              // error-policy:J3 preserve explicitly non-JSON tool arguments as
              // a string; callers can validate the declared schema.
              return argsValue;
            }
          })()
        : argsValue;
    out.push({
      id,
      name,
      arguments: (parsed && typeof parsed === "object"
        ? parsed
        : { value: parsed }) as ToolCall["arguments"],
    });
  }
  return out;
}

function usageFromCounts(
  promptTokens: number | undefined,
  completionTokens: number | undefined,
  promptForEstimate: string,
  text: string
): TokenUsage {
  if (typeof promptTokens === "number" || typeof completionTokens === "number") {
    return {
      promptTokens: promptTokens ?? 0,
      completionTokens: completionTokens ?? 0,
      totalTokens: (promptTokens ?? 0) + (completionTokens ?? 0),
    };
  }
  return estimateUsage(promptForEstimate, text);
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    // error-policy:J2 response bytes are part of the provider contract; preserve
    // the read failure instead of fabricating an empty successful body.
    throw new ZerollamaHttpError({
      message: `Unable to read zerollama HTTP response: ${error instanceof Error ? error.message : String(error)}`,
      statusCode: response.status,
      responseBody: "response body unavailable",
      url: response.url || "unknown",
    });
  }
}

export class ZerollamaHttpError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;
  readonly url: string;

  constructor(args: {
    message: string;
    statusCode: number;
    responseBody: string;
    url: string;
  }) {
    super(args.message);
    this.name = "ZerollamaHttpError";
    this.statusCode = args.statusCode;
    this.responseBody = args.responseBody;
    this.url = args.url;
  }
}

export async function zerollamaChatComplete(args: {
  apiBase: string;
  body: ZerollamaChatRequest;
  fetchImpl?: typeof fetch;
  promptForEstimate: string;
  modelName: string;
  signal?: AbortSignal;
}): Promise<GenerateTextResult> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = `${args.apiBase.replace(/\/+$/, "")}/api/chat`;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...args.body, stream: false }),
    signal: args.signal,
  });
  const raw = await readErrorBody(response);
  if (!response.ok) {
    throw new ZerollamaHttpError({
      message: `zerollama /api/chat failed (${response.status})`,
      statusCode: response.status,
      responseBody: raw,
      url,
    });
  }
  let parsed: ChatStreamEvent;
  try {
    parsed = JSON.parse(raw) as ChatStreamEvent;
  } catch {
    // error-policy:J3 a successful chat response must be valid JSON; translate
    // invalid provider output into a typed boundary error.
    throw new ZerollamaHttpError({
      message: "zerollama /api/chat returned non-JSON",
      statusCode: response.status,
      responseBody: raw,
      url,
    });
  }
  if (parsed.error) {
    throw new ZerollamaHttpError({
      message: parsed.error,
      statusCode: 400,
      responseBody: raw,
      url,
    });
  }
  const text = parsed.message?.content ?? "";
  const toolCalls = mapWireToolCalls(parsed.message?.tool_calls);
  const usage = usageFromCounts(
    parsed.prompt_eval_count,
    parsed.eval_count,
    args.promptForEstimate,
    text
  );
  return {
    text,
    toolCalls,
    finishReason: parsed.done_reason ?? (toolCalls.length > 0 ? "tool-calls" : "stop"),
    usage,
    providerMetadata: { modelName: args.modelName, provider: "zerollama" },
  };
}

export function zerollamaChatStream(args: {
  apiBase: string;
  body: ZerollamaChatRequest;
  fetchImpl?: typeof fetch;
  promptForEstimate: string;
  modelName: string;
  /** When true, suppress text deltas and yield a single planner JSON chunk at end. */
  plannerToolArgsOnly?: boolean;
  signal?: AbortSignal;
}): TextStreamResult & { toolCalls?: Promise<ToolCall[]> } {
  const fetchImpl = args.fetchImpl ?? fetch;
  const url = `${args.apiBase.replace(/\/+$/, "")}/api/chat`;

  let resolveText!: (value: string) => void;
  let rejectText!: (reason?: unknown) => void;
  const textPromise = new Promise<string>((resolve, reject) => {
    resolveText = resolve;
    rejectText = reject;
  });

  let resolveUsage!: (value: TokenUsage | undefined) => void;
  const usagePromise = new Promise<TokenUsage | undefined>((resolve) => {
    resolveUsage = resolve;
  });

  let resolveFinish!: (value: string | undefined) => void;
  const finishPromise = new Promise<string | undefined>((resolve) => {
    resolveFinish = resolve;
  });

  let resolveTools!: (value: ToolCall[]) => void;
  const toolCallsPromise = new Promise<ToolCall[]>((resolve) => {
    resolveTools = resolve;
  });

  async function* textStream(): AsyncIterable<string> {
    let fullText = "";
    let toolCalls: ToolCall[] = [];
    let finishReason: string | undefined;
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...args.body, stream: true }),
        signal: args.signal,
      });
      if (!response.ok) {
        const raw = await readErrorBody(response);
        throw new ZerollamaHttpError({
          message: `zerollama /api/chat stream failed (${response.status})`,
          statusCode: response.status,
          responseBody: raw,
          url,
        });
      }
      if (!response.body) {
        throw new ZerollamaHttpError({
          message: "zerollama /api/chat stream missing body",
          statusCode: response.status,
          responseBody: "",
          url,
        });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let event: ChatStreamEvent;
          try {
            event = JSON.parse(trimmed) as ChatStreamEvent;
          } catch {
            // error-policy:J3 every non-empty NDJSON line is a protocol event;
            // malformed data is an explicit provider failure, never skipped.
            throw new ZerollamaHttpError({
              message: "zerollama /api/chat stream returned malformed NDJSON",
              statusCode: response.status,
              responseBody: trimmed,
              url,
            });
          }
          if (event.error) {
            throw new ZerollamaHttpError({
              message: event.error,
              statusCode: 400,
              responseBody: trimmed,
              url,
            });
          }
          const delta = event.message?.content ?? "";
          if (delta && !args.plannerToolArgsOnly) {
            fullText += delta;
            yield delta;
          } else if (delta) {
            fullText += delta;
          }
          if (event.message?.tool_calls?.length) {
            toolCalls = mapWireToolCalls(event.message.tool_calls);
          }
          if (typeof event.prompt_eval_count === "number") {
            promptTokens = event.prompt_eval_count;
          }
          if (typeof event.eval_count === "number") {
            completionTokens = event.eval_count;
          }
          if (event.done) {
            finishReason = event.done_reason ?? (toolCalls.length > 0 ? "tool-calls" : "stop");
          }
        }
      }

      if (args.plannerToolArgsOnly) {
        if (toolCalls[0]) {
          const argsJson =
            typeof toolCalls[0].arguments === "string"
              ? toolCalls[0].arguments
              : JSON.stringify(toolCalls[0].arguments);
          yield argsJson;
          fullText = argsJson;
        } else if (fullText) {
          // No forced tool call arrived (tool_choice is never sent on the
          // native wire, so small/quantized models often answer with plain
          // plan text). Yield the drained plan so core's textStream-only
          // accumulator receives it, mirroring the AI-SDK sibling's
          // `fallbackText` yield in models/text.ts. Without this the planner
          // parse sees an empty string and the agent produces no reply.
          yield fullText;
        }
      }

      resolveText(fullText);
      resolveTools(toolCalls);
      resolveFinish(finishReason);
      resolveUsage(
        usageFromCounts(promptTokens, completionTokens, args.promptForEstimate, fullText)
      );
    } catch (err) {
      // error-policy:J2 attach the stream endpoint to raw transport failures
      // while preserving already-classified HTTP/protocol errors.
      const failure =
        err instanceof ZerollamaHttpError
          ? err
          : new ZerollamaHttpError({
              message: `zerollama /api/chat stream failed: ${err instanceof Error ? err.message : String(err)}`,
              statusCode: 0,
              responseBody: "stream transport failed",
              url,
            });
      rejectText(failure);
      resolveTools(toolCalls);
      resolveFinish(finishReason);
      resolveUsage(undefined);
      throw failure;
    }
  }

  return {
    textStream: textStream(),
    text: textPromise,
    usage: usagePromise,
    finishReason: finishPromise,
    toolCalls: toolCallsPromise,
  };
}

/**
 * Zerollama EmbedRequest accepts only `string | string[]`. Objects / numbers
 * yield HTTP 400 `invalid input type`. Coerce common caller shapes before wire.
 */
export function normalizeZerollamaEmbedInput(input: unknown): string | string[] {
  if (typeof input === "string") return input;
  if (Array.isArray(input)) {
    if (input.every((item) => typeof item === "string")) {
      return input as string[];
    }
    return input.map((item) =>
      typeof item === "string"
        ? item
        : item == null
          ? ""
          : typeof item === "object" &&
              item !== null &&
              typeof (item as { text?: unknown }).text === "string"
            ? (item as { text: string }).text
            : String(item)
    );
  }
  if (input && typeof input === "object") {
    const row = input as { text?: unknown; texts?: unknown };
    if (typeof row.text === "string") return row.text;
    if (Array.isArray(row.texts)) return normalizeZerollamaEmbedInput(row.texts);
  }
  if (input == null) return "";
  return String(input);
}

function parseEmbedVectors(raw: string, url: string): number[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // error-policy:J3 a successful embed response must be valid JSON; translate
    // invalid provider output into a typed boundary error.
    throw new ZerollamaHttpError({
      message: "zerollama embed returned non-JSON",
      statusCode: 502,
      responseBody: raw,
      url,
    });
  }
  const body = asRecord(parsed);
  if (typeof body.error === "string" && body.error.length > 0) {
    throw new ZerollamaHttpError({
      message: body.error,
      statusCode: 400,
      responseBody: raw,
      url,
    });
  }
  // Native /api/embed: { embeddings: number[][] }
  if (Array.isArray(body.embeddings)) {
    return body.embeddings as number[][];
  }
  // Legacy /api/embeddings: { embedding: number[] }
  if (Array.isArray(body.embedding)) {
    return [body.embedding as number[]];
  }
  // OpenAI /v1/embeddings: { data: [{ embedding: number[] }] }
  if (Array.isArray(body.data)) {
    return (body.data as Array<{ embedding?: number[] }>)
      .map((row) => row.embedding)
      .filter((row): row is number[] => Array.isArray(row));
  }
  return [];
}

export async function zerollamaEmbed(args: {
  apiBase: string;
  model: string;
  input: unknown;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<number[]> {
  const vectors = await zerollamaEmbedMany(args);
  const vector = vectors[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("[Ollama] zerollama embed returned an empty embedding");
  }
  return vector;
}

/** Embed one or many texts via zerollama (`/api/embed`, with `/v1/embeddings` fallback). */
export async function zerollamaEmbedMany(args: {
  apiBase: string;
  model: string;
  input: unknown;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<number[][]> {
  const fetchImpl = args.fetchImpl ?? fetch;
  const apiBase = args.apiBase.replace(/\/+$/, "");
  const input = normalizeZerollamaEmbedInput(args.input);
  const model = String(args.model ?? "").trim();
  if (!model) {
    throw new Error("[Ollama] zerollama embed requires a non-empty model name");
  }

  const nativeUrl = `${apiBase}/api/embed`;
  const nativeBody = JSON.stringify({ model, input });
  const nativeResponse = await fetchImpl(nativeUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: nativeBody,
    signal: args.signal,
  });
  const nativeRaw = await readErrorBody(nativeResponse);
  if (nativeResponse.ok) {
    const vectors = parseEmbedVectors(nativeRaw, nativeUrl);
    if (vectors.length > 0 && vectors.every((row) => row.length > 0)) {
      return vectors;
    }
    // Missing `input` (only `prompt`) yields HTTP 200 + empty embeddings on
    // zerollama — fall through to OpenAI-compatible path rather than succeeding
    // with nothing.
  } else if (nativeResponse.status !== 400 && nativeResponse.status !== 501) {
    throw new ZerollamaHttpError({
      message: `zerollama /api/embed failed (${nativeResponse.status}): ${nativeRaw.slice(0, 300)}`,
      statusCode: nativeResponse.status,
      responseBody: nativeRaw,
      url: nativeUrl,
    });
  }

  // Fallback: OpenAI-compatible route (same EmbedRequest input types; useful when
  // /api/embed rejects a payload the v1 path accepts, or returns empty vectors).
  const v1Url = `${apiBase}/v1/embeddings`;
  const v1Response = await fetchImpl(v1Url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input }),
    signal: args.signal,
  });
  const v1Raw = await readErrorBody(v1Response);
  if (!v1Response.ok) {
    throw new ZerollamaHttpError({
      message: `zerollama embed failed (/api/embed ${nativeResponse.status}: ${nativeRaw.slice(0, 160)}; /v1/embeddings ${v1Response.status}: ${v1Raw.slice(0, 160)}) [model=${model}]`,
      statusCode: v1Response.status,
      responseBody: v1Raw || nativeRaw,
      url: v1Url,
    });
  }
  const v1Vectors = parseEmbedVectors(v1Raw, v1Url);
  if (v1Vectors.length === 0 || v1Vectors.some((row) => row.length === 0)) {
    throw new Error(
      `[Ollama] zerollama embed returned an empty embedding (model=${model}; /api/embed body=${nativeRaw.slice(0, 120)})`
    );
  }
  return v1Vectors;
}

/** Extract a JSON Schema object from Eliza/AI SDK `responseSchema` shapes. */
export function extractFormatFromResponseSchema(
  responseSchema: unknown
): string | Record<string, unknown> | undefined {
  if (responseSchema == null) return undefined;
  if (typeof responseSchema === "string") return responseSchema;
  if (typeof responseSchema !== "object") return undefined;
  const row = asRecord(responseSchema);
  if (row.schema && typeof row.schema === "object") {
    return asRecord(row.schema);
  }
  if (row.type || row.properties) return row;
  return "json";
}
