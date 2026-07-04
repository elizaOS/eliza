/**
 * HTTP client for the ChatGPT Codex `/responses` SSE endpoint, plus the
 * provider-neutral message/tool translation it needs. CodexBackend loads the
 * codex CLI OAuth token, posts a Responses-API request, and consumes the event
 * stream into text, native tool calls, finish reason, and token usage.
 *
 * Calls on one instance serialize through a FIFO tail promise with optional
 * pre-request jitter. A 401 triggers exactly one OAuth refresh-and-retry. The
 * base URL is restricted to chatgpt.com or localhost to prevent token
 * exfiltration, and temperature/max_output_tokens are never sent because the
 * gpt-5.x reasoning models reject them with a 400.
 */
import { logger, type ChatMessage, type JsonValue, type ToolCall, type ToolDefinition } from "@elizaos/core";
import { parseSSE } from "./sse-parser";
import { toOpenAITool, type OpenAITool } from "./tool-format-openai";
import {
  defaultAuthPath,
  loadCodexAuth as loadCodexAuthDefault,
  refreshCodexAuth as refreshCodexAuthDefault,
  type CodexAuth,
} from "./codex-auth";

export type { CodexAuth } from "./codex-auth";
export type { OpenAITool } from "./tool-format-openai";

export interface CodexBackendConfig {
  authPath?: string;
  model?: string;
  baseUrl?: string;
  userAgent?: string;
  originator?: string;
  jitterMaxMs?: number;
  fetchImpl?: typeof fetch;
  loadAuth?: (path: string) => Promise<CodexAuth>;
  refreshAuth?: (currentAuth: CodexAuth, path: string) => Promise<CodexAuth>;
  toolTranslator?: (tool: ToolDefinition) => OpenAITool;
}

type CodexToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "tool"; name: string }
  | { type: "function"; function: { name: string } }
  | { name: string };

export interface CodexGenerateParams {
  prompt: string;
  system?: string;
  messages?: ChatMessage[];
  tools?: ToolDefinition[];
  toolChoice?: CodexToolChoice;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  responseFormat?:
    | { type: "json_object" | "text" }
    | { type: "json_schema"; schema: Record<string, unknown> }
    | string;
}

export interface CodexGenerateResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
}

type CodexInputItem =
  | {
      type: "message";
      role: "user" | "assistant" | "system";
      content: Array<{ type: "input_text" | "output_text"; text: string }>;
    }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

interface CodexResponseBody {
  model: string;
  instructions: string;
  input: CodexInputItem[];
  store: false;
  stream: true;
  tools?: OpenAITool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string };
  text?: { format: { type: "json_object" } };
  // NB: the ChatGPT codex backend rejects `temperature` and `max_output_tokens`
  // (gpt-5.x reasoning models) with 400 "Unsupported parameter" — never include
  // them in the request body.
}

const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_USER_AGENT = "codex_cli_rs/0.124.0";
const DEFAULT_ORIGINATOR = "codex_cli_rs";
const DEFAULT_JITTER_MAX_MS = 200;
const DEFAULT_JITTER_MIN_MS = 50;

export class CodexBackend {
  readonly name = "codex-cli";
  private readonly authPath: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly originator: string;
  private readonly jitterMaxMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly loadAuth: (path: string) => Promise<CodexAuth>;
  private readonly refreshAuth: (currentAuth: CodexAuth, path: string) => Promise<CodexAuth>;
  private readonly toolTranslator: (tool: ToolDefinition) => OpenAITool;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(config: CodexBackendConfig = {}) {
    this.authPath = config.authPath ?? process.env.CODEX_AUTH_PATH ?? defaultAuthPath();
    this.model = config.model ?? process.env.CODEX_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = validateBaseUrl(stripTrailingSlash(config.baseUrl ?? process.env.CODEX_BASE_URL ?? DEFAULT_BASE_URL));
    this.userAgent = config.userAgent ?? process.env.CODEX_USER_AGENT ?? DEFAULT_USER_AGENT;
    this.originator = config.originator ?? process.env.CODEX_ORIGINATOR ?? DEFAULT_ORIGINATOR;
    this.jitterMaxMs = config.jitterMaxMs ?? envInt("CODEX_JITTER_MS_MAX", DEFAULT_JITTER_MAX_MS);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.loadAuth = config.loadAuth ?? loadCodexAuthDefault;
    this.refreshAuth = config.refreshAuth ?? refreshCodexAuthDefault;
    this.toolTranslator = config.toolTranslator ?? toOpenAITool;
  }

  async generate(params: CodexGenerateParams): Promise<CodexGenerateResult> {
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prior;
      await this.jitter();
      return await this.generateInner(params);
    } finally {
      release();
    }
  }

  private async jitter(): Promise<void> {
    if (this.jitterMaxMs <= 0) return;
    const lo = Math.min(DEFAULT_JITTER_MIN_MS, this.jitterMaxMs);
    const span = Math.max(0, this.jitterMaxMs - lo);
    await new Promise((resolve) => setTimeout(resolve, lo + Math.floor(Math.random() * (span + 1))));
  }

  private async generateInner(params: CodexGenerateParams): Promise<CodexGenerateResult> {
    const systemPrompt = params.system ?? extractSystemPrompt(params.messages) ?? "";
    const body: CodexResponseBody = {
      model: params.model ?? this.model,
      instructions: systemPrompt,
      input: translateMessagesToCodexInput(params.messages, params.prompt),
      store: false,
      stream: true,
    };
    const tools = (params.tools ?? []).map((tool) => this.toolTranslator(tool));
    if (tools.length > 0) body.tools = tools;
    const toolChoice = toCodexToolChoice(params.toolChoice);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
    // The ChatGPT codex backend (gpt-5.x reasoning models on the Responses API)
    // rejects `temperature` and `max_output_tokens` with a 400 "Unsupported
    // parameter" — reasoning models honor neither, and the official codex CLI
    // never sends them. The runtime's planner/response-handler calls always pass
    // maxTokens (and often temperature), so forwarding them 400'd every codex
    // turn → empty result → no reply. Never send them to the codex backend.
    if (isJsonResponse(params.responseFormat)) body.text = { format: { type: "json_object" } };

    let auth = await this.loadAuth(this.authPath);
    let res = await this.postResponses(auth, body, params.abortSignal);
    if (res.status === 401) {
      logger.warn("[codex-cli] 401 from /responses, refreshing OAuth and retrying once");
      auth = await this.refreshAuth(auth, this.authPath);
      res = await this.postResponses(auth, body, params.abortSignal);
    }
    if (!res.ok) {
      const errText = await safeReadText(res);
      throw new Error(`codex /responses returned ${res.status} ${res.statusText} :: ${errText.slice(0, 512)}`);
    }
    if (!res.body) throw new Error("codex /responses returned no body");
    return consumeResponseStream(res.body, params.abortSignal, params.onTextDelta);
  }

  private async postResponses(auth: CodexAuth, body: CodexResponseBody, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.tokens.access_token}`,
      "Content-Type": "application/json",
      originator: this.originator,
      "User-Agent": this.userAgent,
      "OpenAI-Beta": "responses=v1",
      Accept: "text/event-stream",
    };
    if (auth.tokens.account_id) headers["chatgpt-account-id"] = auth.tokens.account_id;
    return this.fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  }
}

export function translateMessagesToCodexInput(messages: ChatMessage[] | undefined, prompt: string): CodexInputItem[] {
  const out: CodexInputItem[] = [];
  if (!messages || messages.length === 0) {
    if (prompt.trim().length > 0) {
      out.push({ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });
    }
    return out;
  }

  let lastText = "";
  // function_call ids emitted but not yet paired with their output, in order.
  // The Responses API rejects a function_call_output whose call_id has no
  // matching function_call ("No tool call found for function call output with
  // call_id ..."), so every output must reference a real preceding call.
  const pendingCallIds: string[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "tool") {
      // A tool turn carries one or more results. The planner renders them as
      // `tool-result` CONTENT PARTS (toolCallId + output on the part); older
      // callers put a single result in plain-text content keyed by the
      // message-level toolCallId. Handle both so the fetched data actually
      // reaches the model — dropping it makes the model believe its own tool
      // call never ran ("I don't have the fetched contents visible here").
      const resultParts = toolResultPartsFromContent(message.content);
      const results =
        resultParts.length > 0
          ? resultParts
          : [{ toolCallId: message.toolCallId, text: contentToText(message.content) }];
      for (const result of results) {
        const wantId = result.toolCallId ?? message.toolCallId;
        let callId: string | undefined;
        const idx = wantId ? pendingCallIds.indexOf(wantId) : -1;
        if (idx >= 0) {
          callId = pendingCallIds[idx];
          pendingCallIds.splice(idx, 1);
        } else if (pendingCallIds.length > 0) {
          callId = pendingCallIds.shift();
        }
        if (callId) {
          out.push({
            type: "function_call_output",
            call_id: callId,
            output: result.text,
          });
        } else if (result.text.trim().length > 0) {
          // Orphaned tool result (no preceding function_call in this
          // transcript): render its content as plain context instead of an
          // unmatched function_call_output that the backend would 400 on.
          out.push({
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: result.text }],
          });
        }
      }
      continue;
    }

    if (message.role === "assistant") {
      const text = contentToText(message.content);
      if (text.length > 0) {
        lastText = text;
        out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      }
      // Tool calls arrive either as a structured `toolCalls` field or as
      // `tool-call` content parts (what the planner renders). Emit both,
      // deduped by id, so the assistant's prior calls are preserved and the
      // following tool results have a real function_call to pair with.
      const seen = new Set<string>();
      const toolCalls = [
        ...(message.toolCalls ?? []).map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.name,
          arguments:
            typeof toolCall.arguments === "string"
              ? toolCall.arguments
              : JSON.stringify(toolCall.arguments ?? {}),
        })),
        ...toolCallPartsFromContent(message.content),
      ];
      for (const toolCall of toolCalls) {
        if (!toolCall.id || seen.has(toolCall.id)) continue;
        seen.add(toolCall.id);
        out.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: toolCall.arguments,
        });
        pendingCallIds.push(toolCall.id);
      }
      continue;
    }

    const text = contentToText(message.content);
    lastText = text;
    out.push({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  }
  if (prompt.trim().length > 0 && prompt !== lastText) {
    out.push({ type: "message", role: "user", content: [{ type: "input_text", text: prompt }] });
  }
  return out;
}

function extractSystemPrompt(messages?: ChatMessage[]): string | undefined {
  const parts = messages
    ?.filter((message) => message.role === "system" || message.role === "developer")
    .map((message) => contentToText(message.content))
    .filter(Boolean);
  return parts && parts.length > 0 ? parts.join("\n\n") : undefined;
}

function contentToText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Flatten a tool-result part's `output`/`result` into a single string. */
function toolOutputText(output: unknown): string {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return contentToText(output as ChatMessage["content"]);
  if (isRecord(output)) {
    if (typeof output.value === "string") return output.value;
    if (typeof output.text === "string") return output.text;
    return JSON.stringify(output);
  }
  return String(output);
}

/** Extract `tool-result` content parts (toolCallId + flattened output text). */
function toolResultPartsFromContent(
  content: ChatMessage["content"],
): Array<{ toolCallId?: string; text: string }> {
  if (!Array.isArray(content)) return [];
  const results: Array<{ toolCallId?: string; text: string }> = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "tool-result") continue;
    results.push({
      toolCallId: typeof part.toolCallId === "string" ? part.toolCallId : undefined,
      text: toolOutputText(part.output ?? part.result),
    });
  }
  return results;
}

/** Extract `tool-call` content parts as codex function-call descriptors. */
function toolCallPartsFromContent(
  content: ChatMessage["content"],
): Array<{ id: string; name: string; arguments: string }> {
  if (!Array.isArray(content)) return [];
  const calls: Array<{ id: string; name: string; arguments: string }> = [];
  for (const part of content) {
    if (!isRecord(part) || part.type !== "tool-call") continue;
    const argSource = part.input ?? part.args ?? {};
    calls.push({
      id: typeof part.toolCallId === "string" ? part.toolCallId : "",
      name: typeof part.toolName === "string" ? part.toolName : "",
      arguments: typeof argSource === "string" ? argSource : JSON.stringify(argSource ?? {}),
    });
  }
  return calls;
}

interface ActiveFunctionCall {
  id: string;
  name: string;
  args: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringProperty(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function recordProperty(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  return isRecord(value) ? value : undefined;
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonRecord(value);
}

async function consumeResponseStream(
  body: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
  onTextDelta?: (delta: string) => void
): Promise<CodexGenerateResult> {
  let text = "";
  const toolCalls: ToolCall[] = [];
  const activeByItemId = new Map<string, ActiveFunctionCall>();
  let finishReason: string | undefined;
  let usage: CodexGenerateResult["usage"] | undefined;
  let failed: { code?: string; message?: string } | null = null;

  const iter = parseSSE(body);
  let abortPromise: Promise<never> | null = null;
  let onAbort: (() => void) | null = null;
  if (abortSignal) {
    abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("codex stream aborted"));
      abortSignal.addEventListener("abort", onAbort, { once: true });
    });
  }

  try {
    while (true) {
      if (abortSignal?.aborted) throw new Error("codex stream aborted");
      const next = abortPromise ? await Promise.race([iter.next(), abortPromise]) : await iter.next();
      if (next.done) break;
      if (!next.value.data) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(next.value.data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const preview = next.value.data.slice(0, 200);
        logger.debug(
          `[codex-cli] dropped malformed SSE event: ${message} preview=${preview}`,
        );
        continue;
      }
      const payloadRecord = isRecord(payload) ? payload : {};
      const evType = next.value.event ?? stringProperty(payloadRecord, "type") ?? "";
      switch (evType) {
        case "response.output_text.delta": {
          const delta = payloadRecord.delta;
          if (typeof delta === "string") {
            text += delta;
            onTextDelta?.(delta);
          }
          break;
        }
        case "response.output_item.added": {
          const item = recordProperty(payloadRecord, "item");
          if (item?.type === "function_call") {
            const itemId = stringProperty(item, "id") ?? stringProperty(item, "call_id");
            const callId = stringProperty(item, "call_id");
            const name = stringProperty(item, "name");
            if (itemId && callId && name) {
              activeByItemId.set(itemId, { id: callId, name, args: "" });
            }
          }
          break;
        }
        case "response.function_call_arguments.delta": {
          const itemId = stringProperty(payloadRecord, "item_id");
          const delta = payloadRecord.delta;
          const call = itemId ? activeByItemId.get(itemId) : undefined;
          if (call && typeof delta === "string") call.args += delta;
          break;
        }
        case "response.output_item.done": {
          const item = recordProperty(payloadRecord, "item");
          if (item?.type === "function_call") {
            const itemId = stringProperty(item, "id") ?? stringProperty(item, "call_id");
            const call = itemId ? activeByItemId.get(itemId) : undefined;
            if (call) {
              const argStr = stringProperty(item, "arguments") ?? call.args;
              let parsed: Record<string, JsonValue> | string = argStr;
              try {
                if (argStr) {
                  const parsedJson: unknown = JSON.parse(argStr);
                  parsed = isJsonRecord(parsedJson) ? parsedJson : argStr;
                } else {
                  parsed = {};
                }
              } catch {
                // keep raw string
              }
              toolCalls.push({ id: call.id, name: call.name, arguments: parsed, type: "function" });
              if (itemId) activeByItemId.delete(itemId);
            }
          }
          break;
        }
        case "response.completed": {
          const resp = recordProperty(payloadRecord, "response");
          const stopReason = resp ? resp.stop_reason : undefined;
          if (stopReason) finishReason = String(stopReason);
          const respUsage = resp ? recordProperty(resp, "usage") : undefined;
          if (respUsage) {
            const inputTokens = numOrZero(respUsage.input_tokens);
            const outputTokens = numOrZero(respUsage.output_tokens);
            usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
          }
          return { text, toolCalls, finishReason, usage };
        }
        case "response.failed": {
          const resp = recordProperty(payloadRecord, "response");
          const error = resp ? recordProperty(resp, "error") : undefined;
          failed = {
            code: error ? stringProperty(error, "code") : undefined,
            message: error ? stringProperty(error, "message") : undefined,
          };
          throw new Error(`codex response.failed: ${failed.code ?? "unknown"} ${failed.message ?? ""}`.trim());
        }
        default:
          break;
      }
    }
  } finally {
    if (abortSignal && onAbort) abortSignal.removeEventListener("abort", onAbort);
    void iter.return?.(undefined).catch(() => {});
    if (!body.locked) void body.cancel().catch(() => {});
  }
  logger.warn(
    `[codex-cli] SSE stream ended without response.completed; returning partial result (text=${text.length} toolCalls=${toolCalls.length} finishReason=${finishReason})`,
  );
  return { text, toolCalls, finishReason, usage };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function validateBaseUrl(value: string): string {
  const url = new URL(value);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (url.hostname === "chatgpt.com" && url.protocol === "https:") return value;
  if (localHosts.has(url.hostname) && (url.protocol === "http:" || url.protocol === "https:")) return value;
  throw new Error("CODEX_BASE_URL may only target https://chatgpt.com or localhost to avoid OAuth token exfiltration");
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function numOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isJsonResponse(responseFormat: CodexGenerateParams["responseFormat"]): boolean {
  return responseFormat === "json_object" || (typeof responseFormat === "object" && responseFormat?.type === "json_object");
}

function toCodexToolChoice(
  toolChoice: CodexGenerateParams["toolChoice"]
): CodexResponseBody["tool_choice"] | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto" || toolChoice === "none" || toolChoice === "required") return toolChoice;
  if ("name" in toolChoice) return { type: "function", name: toolChoice.name };
  return { type: "function", name: toolChoice.function.name };
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
