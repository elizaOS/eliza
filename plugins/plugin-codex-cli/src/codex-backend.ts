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
  responseFormat?: { type: "json_object" | "text" } | string;
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
  temperature?: number;
  max_output_tokens?: number;
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
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.maxTokens !== undefined) body.max_output_tokens = params.maxTokens;
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
  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "tool") {
      out.push({
        type: "function_call_output",
        call_id: message.toolCallId ?? "tool_call",
        output: contentToText(message.content),
      });
      continue;
    }

    if (message.role === "assistant") {
      const text = contentToText(message.content);
      if (text.length > 0) {
        lastText = text;
        out.push({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
      }
      for (const toolCall of message.toolCalls ?? []) {
        out.push({
          type: "function_call",
          call_id: toolCall.id,
          name: toolCall.name,
          arguments: typeof toolCall.arguments === "string" ? toolCall.arguments : JSON.stringify(toolCall.arguments ?? {}),
        });
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

interface ActiveFunctionCall {
  id: string;
  name: string;
  args: string;
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
      let payload: any;
      try {
        payload = JSON.parse(next.value.data);
      } catch {
        continue;
      }
      const evType: string = next.value.event ?? payload?.type ?? "";
      switch (evType) {
        case "response.output_text.delta": {
          if (typeof payload.delta === "string") {
            text += payload.delta;
            onTextDelta?.(payload.delta);
          }
          break;
        }
        case "response.output_item.added": {
          const item = payload.item;
          if (item?.type === "function_call") activeByItemId.set(item.id ?? item.call_id, { id: item.call_id, name: item.name, args: "" });
          break;
        }
        case "response.function_call_arguments.delta": {
          const call = activeByItemId.get(payload.item_id);
          if (call && typeof payload.delta === "string") call.args += payload.delta;
          break;
        }
        case "response.output_item.done": {
          const item = payload.item;
          if (item?.type === "function_call") {
            const itemId = item.id ?? item.call_id;
            const call = activeByItemId.get(itemId);
            if (call) {
              const argStr = typeof item.arguments === "string" ? item.arguments : call.args;
              let parsed: Record<string, JsonValue> | string = argStr;
              try {
                parsed = argStr ? (JSON.parse(argStr) as Record<string, JsonValue>) : {};
              } catch {
                // keep raw string
              }
              toolCalls.push({ id: call.id, name: call.name, arguments: parsed, type: "function" });
              activeByItemId.delete(itemId);
            }
          }
          break;
        }
        case "response.completed": {
          const resp = payload.response;
          if (resp?.stop_reason) finishReason = String(resp.stop_reason);
          if (resp?.usage) {
            const inputTokens = numOrZero(resp.usage.input_tokens);
            const outputTokens = numOrZero(resp.usage.output_tokens);
            usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
          }
          return { text, toolCalls, finishReason, usage };
        }
        case "response.failed": {
          const resp = payload.response;
          failed = { code: resp?.error?.code, message: resp?.error?.message };
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
  logger.warn("[codex-cli] SSE stream ended without response.completed");
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
