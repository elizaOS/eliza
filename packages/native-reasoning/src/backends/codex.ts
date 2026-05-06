/**
 * CodexBackend — chatgpt-prolite "stealth" reasoning backend.
 *
 * Talks to `https://chatgpt.com/backend-api/codex/responses` using the
 * OAuth tokens cached by the official `codex` CLI in `~/.codex/auth.json`.
 * The wire shape is OpenAI's `responses` API (event-stream), wrapped with
 * codex-specific headers (originator, chatgpt-account-id, codex_cli_rs UA).
 *
 * Wires together:
 *   - Wave A: `ReasoningBackend` interface + unified TurnMessage types
 *   - Wave C: `loadCodexAuth` + `refreshCodexAuth` (atomic file-locked
 *     OAuth refresh) and `parseSSE` (spec-compliant streaming SSE parser)
 *   - Wave D: `toOpenAITool` (NativeTool → OpenAI function tool)
 *
 * The constructor accepts overrides for every third-party dep (fetch, auth
 * load+refresh, tool translator) so tests can run in full isolation
 * without touching the real filesystem or network.
 *
 * Concurrency:
 *   - Single in-process semaphore (FIFO promise chain). One in-flight
 *     request at a time per backend instance. Cheap soft mitigation
 *     against the chatgpt account being flagged for parallel sessions.
 *   - 50–CODEX_JITTER_MS_MAX ms jitter before each request.
 *
 * Retries:
 *   - On 401: refreshCodexAuth() then retry ONCE. Other errors propagate.
 */

import os from "node:os";
import path from "node:path";

import { logger } from "@elizaos/core";

import { parseSSE } from "../sse-parser.js";
import { type OpenAITool, toOpenAITool } from "../tool-format/openai.js";
import type { NativeTool } from "../tool-schema.js";
import {
  type CodexAuth,
  loadCodexAuth as loadCodexAuthDefault,
  refreshCodexAuth as refreshCodexAuthDefault,
} from "./codex-auth.js";
import type {
  CallTurnOptions,
  ReasoningBackend,
  TextBlock,
  ToolCallRequest,
  ToolUseBlock,
  TurnMessage,
  TurnResult,
} from "./types.js";

export type { OpenAITool } from "../tool-format/openai.js";
export type { CodexAuth } from "./codex-auth.js";

/** Local convenience type — Wave A's TurnResult.usage shape. */
type TurnUsage = NonNullable<TurnResult["usage"]>;

// ---------------------------------------------------------------------------
// Injection seams
// ---------------------------------------------------------------------------

export type ToolTranslator = (t: NativeTool) => OpenAITool;
export type LoadAuthFn = (path: string) => Promise<CodexAuth>;
/**
 * Auth-refresh signature. Wave C: `(currentAuth, path) => Promise<CodexAuth>`.
 * The backend always passes both; injected stubs may ignore the first arg.
 */
export type RefreshAuthFn = (
  currentAuth: CodexAuth,
  path: string,
) => Promise<CodexAuth>;

export interface CodexBackendConfig {
  authPath?: string;
  model?: string;
  baseUrl?: string;
  userAgent?: string;
  originator?: string;
  jitterMaxMs?: number;
  fetchImpl?: typeof fetch;
  loadAuth?: LoadAuthFn;
  refreshAuth?: RefreshAuthFn;
  toolTranslator?: ToolTranslator;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api/codex";
const DEFAULT_USER_AGENT = "codex_cli_rs/0.124.0";
const DEFAULT_ORIGINATOR = "codex_cli_rs";
const DEFAULT_JITTER_MAX_MS = 200;
const DEFAULT_JITTER_MIN_MS = 50;

// ---------------------------------------------------------------------------
// Wire types — codex `input` array discriminated union
// ---------------------------------------------------------------------------

type CodexInputItem =
  | {
      type: "message";
      role: "user" | "assistant" | "system";
      content: Array<{
        type: "input_text" | "output_text";
        text: string;
      }>;
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string;
    };

interface CodexResponseBody {
  model: string;
  instructions: string;
  input: CodexInputItem[];
  store: false;
  stream: true;
  tools?: OpenAITool[];
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export class CodexBackend implements ReasoningBackend {
  readonly name = "codex";
  private readonly authPath: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly originator: string;
  private readonly jitterMaxMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly loadAuth: LoadAuthFn;
  private readonly refreshAuth: RefreshAuthFn;
  private readonly toolTranslator: ToolTranslator;

  /** FIFO concurrency tail; chained Promise serializes calls. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(config: CodexBackendConfig = {}) {
    this.authPath =
      config.authPath ?? process.env.CODEX_AUTH_PATH ?? DEFAULT_AUTH_PATH;
    this.model = config.model ?? process.env.CODEX_MODEL ?? DEFAULT_MODEL;
    this.baseUrl = stripTrailingSlash(
      config.baseUrl ?? process.env.CODEX_BASE_URL ?? DEFAULT_BASE_URL,
    );
    this.userAgent =
      config.userAgent ?? process.env.CODEX_USER_AGENT ?? DEFAULT_USER_AGENT;
    this.originator =
      config.originator ?? process.env.CODEX_ORIGINATOR ?? DEFAULT_ORIGINATOR;
    this.jitterMaxMs =
      config.jitterMaxMs ??
      envInt("CODEX_JITTER_MS_MAX", DEFAULT_JITTER_MAX_MS);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.loadAuth = config.loadAuth ?? loadCodexAuthDefault;
    this.refreshAuth = config.refreshAuth ?? refreshCodexAuthDefault;
    this.toolTranslator = config.toolTranslator ?? toOpenAITool;
  }

  async callTurn(opts: CallTurnOptions): Promise<TurnResult> {
    // Serialize on the in-process tail. We capture the prior tail, then
    // install a new one that resolves regardless of our success/failure
    // (so a thrown error doesn't poison the chain).
    const prior = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await prior;
      await this.jitter();
      return await this.callTurnInner(opts);
    } finally {
      release();
    }
  }

  private async jitter(): Promise<void> {
    if (this.jitterMaxMs <= 0) return;
    const lo = Math.min(DEFAULT_JITTER_MIN_MS, this.jitterMaxMs);
    const span = Math.max(0, this.jitterMaxMs - lo);
    const ms = lo + Math.floor(Math.random() * (span + 1));
    await new Promise((r) => setTimeout(r, ms));
  }

  private async callTurnInner(opts: CallTurnOptions): Promise<TurnResult> {
    const input = translateMessagesToCodexInput(opts.messages);
    const tools = opts.tools.map((t) => this.toolTranslator(t));
    const body: CodexResponseBody = {
      model: this.model,
      instructions: opts.systemPrompt,
      input,
      store: false,
      stream: true,
    };
    if (tools.length > 0) body.tools = tools;

    // First attempt with current auth.
    let auth = await this.loadAuth(this.authPath);
    let res = await this.postResponses(auth, body, opts.abortSignal);
    if (res.status === 401) {
      logger.warn(
        "[codex] 401 from /responses — refreshing OAuth and retrying once",
      );
      try {
        auth = await this.refreshAuth(auth, this.authPath);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`codex auth refresh failed: ${msg}`);
      }
      res = await this.postResponses(auth, body, opts.abortSignal);
    }
    if (!res.ok) {
      const errText = await safeReadText(res);
      throw new Error(
        `codex /responses returned ${res.status} ${res.statusText} :: ${errText.slice(0, 512)}`,
      );
    }
    if (!res.body) {
      throw new Error("codex /responses returned no body");
    }
    return await consumeResponseStream(res.body, opts.abortSignal);
  }

  private async postResponses(
    auth: CodexAuth,
    body: CodexResponseBody,
    signal?: AbortSignal,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.tokens.access_token}`,
      "Content-Type": "application/json",
      originator: this.originator,
      "User-Agent": this.userAgent,
      "OpenAI-Beta": "responses=v1",
      Accept: "text/event-stream",
    };
    if (auth.tokens.account_id) {
      headers["chatgpt-account-id"] = auth.tokens.account_id;
    }
    return this.fetchImpl(`${this.baseUrl}/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  }
}

// ---------------------------------------------------------------------------
// Translation: TurnMessage[] → codex input array
// ---------------------------------------------------------------------------

export function translateMessagesToCodexInput(
  messages: TurnMessage[],
): CodexInputItem[] {
  const out: CodexInputItem[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      // User turns may carry text blocks OR tool_result blocks (when the
      // loop is using Anthropic-style role tagging where role:"user"
      // holds tool results).
      const textBlocks = m.content.filter(
        (b): b is TextBlock => b.type === "text",
      );
      if (textBlocks.length > 0) {
        const text = textBlocks.map((b) => b.text).join("");
        out.push({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        });
      }
      for (const b of m.content) {
        if (b.type === "tool_result") {
          out.push({
            type: "function_call_output",
            call_id: b.tool_use_id,
            output: b.content,
          });
        }
      }
    } else if (m.role === "assistant") {
      const textBlocks = m.content.filter(
        (b): b is TextBlock => b.type === "text",
      );
      if (textBlocks.length > 0) {
        const text = textBlocks.map((b) => b.text).join("");
        if (text.length > 0) {
          out.push({
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text }],
          });
        }
      }
      for (const b of m.content) {
        if (b.type === "tool_use") {
          out.push({
            type: "function_call",
            call_id: b.id,
            name: b.name,
            arguments: b.input === undefined ? "" : JSON.stringify(b.input),
          });
        }
      }
    } else if (m.role === "tool") {
      for (const b of m.content) {
        if (b.type === "tool_result") {
          out.push({
            type: "function_call_output",
            call_id: b.tool_use_id,
            output: b.content,
          });
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// SSE response consumption (uses Wave C parseSSE generator)
// ---------------------------------------------------------------------------

interface ActiveFunctionCall {
  id: string;
  name: string;
  args: string;
}

interface FailureInfo {
  code?: string;
  message?: string;
}

async function consumeResponseStream(
  body: ReadableStream<Uint8Array>,
  abortSignal?: AbortSignal,
): Promise<TurnResult> {
  let text = "";
  const completedToolCalls: ToolCallRequest[] = [];
  const activeByItemId = new Map<string, ActiveFunctionCall>();
  let stopReason: string | undefined;
  let usage: TurnUsage | undefined;
  let failed: FailureInfo | null = null;
  let lastSeq: number | undefined;

  if (abortSignal?.aborted) {
    throw new Error("codex stream aborted before start");
  }

  // Wave C's parseSSE owns the reader (locks the stream). We can't call
  // body.cancel() externally because that throws on a locked stream. So
  // we race iter.next() against an abort promise; on abort we tell the
  // generator to return() (which releases the reader lock & cancels).
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
      if (abortSignal?.aborted) {
        throw new Error("codex stream aborted");
      }
      const next = abortPromise
        ? await Promise.race([iter.next(), abortPromise])
        : await iter.next();
      if (next.done) {
        if (abortSignal?.aborted) {
          throw new Error("codex stream aborted");
        }
        break;
      }
      const ev = next.value;
      if (!ev.data) continue;
      let payload: any;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        // keepalives / comments / non-JSON — skip
        continue;
      }
      const evType: string = ev.event ?? payload?.type ?? "";
      if (typeof payload?.sequence_number === "number") {
        lastSeq = payload.sequence_number;
      }
      try {
        handleEvent(evType, payload, {
          addText: (s) => {
            text += s;
          },
          startCall: (itemId, callId, name) => {
            activeByItemId.set(itemId, { id: callId, name, args: "" });
          },
          appendCallArgs: (itemId, delta) => {
            const a = activeByItemId.get(itemId);
            if (a) a.args += delta;
          },
          finishCall: (itemId, finalArgs) => {
            const a = activeByItemId.get(itemId);
            if (!a) return;
            const argStr = finalArgs ?? a.args;
            let parsedInput: unknown;
            try {
              parsedInput = argStr ? JSON.parse(argStr) : {};
            } catch {
              parsedInput = argStr;
            }
            completedToolCalls.push({
              id: a.id,
              name: a.name,
              input: parsedInput,
            });
            activeByItemId.delete(itemId);
          },
          setStopReason: (r) => {
            stopReason = r;
          },
          setUsage: (u) => {
            usage = u;
          },
          setFailed: (f) => {
            failed = f;
          },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `codex SSE handler error on event '${evType}' (seq=${lastSeq ?? "?"}): ${msg}`,
        );
      }
      if (evType === "response.completed") {
        return finalize(text, completedToolCalls, stopReason, usage);
      }
      if (evType === "response.failed") {
        const f = failed as FailureInfo | null;
        throw new Error(
          `codex response.failed (seq=${lastSeq ?? "?"}): ${
            f?.code ?? "unknown"
          } ${f?.message ?? ""}`.trim(),
        );
      }
    }
  } finally {
    if (abortSignal && onAbort) {
      abortSignal.removeEventListener("abort", onAbort);
    }
    // Fire-and-forget the generator return + body cancel. We deliberately
    // do NOT await: parseSSE may be parked on `reader.read()` which won't
    // resolve until the underlying source produces more bytes, and we need
    // to surface the abort error to the caller right now.
    void iter.return?.(undefined).catch(() => {
      /* ignore */
    });
    // Cancel the body too, in case parseSSE hasn't locked it yet.
    if (!body.locked) {
      void body.cancel().catch(() => {
        /* ignore */
      });
    }
  }

  // Stream ended without response.completed — return what we have but warn.
  logger.warn(
    `[codex] SSE stream ended without response.completed (lastSeq=${lastSeq ?? "?"})`,
  );
  return finalize(text, completedToolCalls, stopReason, usage);
}

interface EventHandlers {
  addText(s: string): void;
  startCall(itemId: string, callId: string, name: string): void;
  appendCallArgs(itemId: string, delta: string): void;
  finishCall(itemId: string, finalArgs?: string): void;
  setStopReason(r: string): void;
  setUsage(u: TurnUsage): void;
  setFailed(f: FailureInfo): void;
}

function handleEvent(evType: string, payload: any, h: EventHandlers): void {
  switch (evType) {
    case "response.created":
    case "response.in_progress":
    case "response.content_part.added":
    case "response.content_part.done":
    case "response.output_text.done":
      return;

    case "response.output_item.added": {
      const item = payload.item;
      if (item?.type === "function_call") {
        const itemId: string = item.id ?? item.call_id;
        h.startCall(itemId, item.call_id, item.name);
      }
      return;
    }

    case "response.output_text.delta": {
      const delta: unknown = payload.delta;
      if (typeof delta === "string") h.addText(delta);
      return;
    }

    case "response.function_call_arguments.delta": {
      const itemId: string = payload.item_id;
      const delta: unknown = payload.delta;
      if (itemId && typeof delta === "string") {
        h.appendCallArgs(itemId, delta);
      }
      return;
    }

    case "response.function_call_arguments.done":
      // Final string arrives on output_item.done; nothing to do here.
      return;

    case "response.output_item.done": {
      const item = payload.item;
      if (item?.type === "function_call") {
        const itemId: string = item.id ?? item.call_id;
        const finalArgs: string | undefined =
          typeof item.arguments === "string" ? item.arguments : undefined;
        h.finishCall(itemId, finalArgs);
      }
      return;
    }

    case "response.completed": {
      const resp = payload.response;
      if (resp?.stop_reason) h.setStopReason(String(resp.stop_reason));
      if (resp?.usage) {
        const inTok = numOrZero(resp.usage.input_tokens);
        const outTok = numOrZero(resp.usage.output_tokens);
        h.setUsage({ input: inTok, output: outTok });
      }
      return;
    }

    case "response.failed": {
      const resp = payload.response;
      h.setFailed({
        code: resp?.error?.code,
        message: resp?.error?.message,
      });
      return;
    }

    default:
      logger.debug(`[codex] unhandled SSE event '${evType}'`);
      return;
  }
}

/**
 * Build a `TurnResult` (Wave A shape) from streaming state. Reconstructs
 * `rawAssistantBlocks` so the loop can echo the assistant turn back into
 * history (text first, then tool_use blocks in completion order).
 */
function finalize(
  text: string,
  toolCalls: ToolCallRequest[],
  stopReason: string | undefined,
  usage: TurnUsage | undefined,
): TurnResult {
  const rawAssistantBlocks: Array<TextBlock | ToolUseBlock> = [];
  if (text.length > 0) {
    rawAssistantBlocks.push({ type: "text", text });
  }
  for (const tc of toolCalls) {
    rawAssistantBlocks.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input: tc.input,
    });
  }
  return { text, toolCalls, stopReason, usage, rawAssistantBlocks };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function numOrZero(n: unknown): number {
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
