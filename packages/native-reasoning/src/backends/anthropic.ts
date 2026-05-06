/**
 * AnthropicBackend — implements ReasoningBackend on top of the official
 * `@anthropic-ai/sdk`. Uses the `advanced-tool-use-2025-11-20` beta.
 *
 * Reads from env on construction:
 *   - ANTHROPIC_BASE_URL  (optional; "/v1" suffix is stripped — many proxies
 *     ship "/v1" terminated URLs but the SDK appends "/v1/messages" itself)
 *   - ANTHROPIC_API_KEY   (optional; defaults to "proxy-handles-auth" so a
 *     reverse-proxy can attach the real credential)
 *   - ANTHROPIC_LARGE_MODEL  (optional; default "claude-opus-4-7")
 *
 * Translates the unified `TurnMessage[]` ↔ Anthropic content blocks at the
 * boundary so the loop never sees Anthropic-shaped types.
 *
 * Includes a 3-attempt retry on transient errors (network failures, 5xx,
 * 429) with linear backoff — lifted from the inline error-handling that
 * used to live in `loop.ts`.
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "@elizaos/core";

import {
  type AnthropicTool,
  toAnthropicTools,
} from "../tool-format/anthropic.js";
import type {
  CallTurnOptions,
  ReasoningBackend,
  TextBlock,
  ToolCallRequest,
  ToolUseBlock,
  TurnContentBlock,
  TurnMessage,
  TurnResult,
} from "./types.js";

const DEFAULT_MODEL = "claude-opus-4-7";
const DEFAULT_MAX_TOKENS = 4096;
const ADVANCED_TOOL_USE_BETA = "advanced-tool-use-2025-11-20";
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 250;

// ---- Anthropic wire types we need at the boundary. Kept loose to be
// resilient to small SDK-version drift in beta block layouts.

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
type AnthropicAssistantBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicAssistantBlock[] | AnthropicToolResultBlock[];
}

interface AnthropicResponse {
  content: AnthropicAssistantBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Minimal client surface we depend on. Real client is the Anthropic SDK's
 * `client.beta.messages` — explicit typing lets tests inject mocks without
 * pulling in the full SDK surface.
 */
export interface AnthropicClientLike {
  beta: {
    messages: {
      create(params: {
        model: string;
        system?: string;
        messages: AnthropicMessage[];
        tools?: AnthropicTool[];
        max_tokens: number;
        betas?: string[];
      }): Promise<AnthropicResponse>;
    };
  };
}

export interface AnthropicBackendOptions {
  /** Override the SDK client (tests). Defaults to a real Anthropic SDK client. */
  client?: AnthropicClientLike;
  /** Override model. Default: env ANTHROPIC_LARGE_MODEL or "claude-opus-4-7". */
  model?: string;
  /** Override max output tokens. Default 4096. */
  maxTokens?: number;
}

function buildDefaultClient(): AnthropicClientLike {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "proxy-handles-auth";
  let baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  // The Anthropic SDK appends "/v1/messages" itself; if the configured base
  // URL already ends in "/v1" (a common proxy convention) strip it to avoid
  // the double "/v1/v1/messages" 404. Idempotent for already-stripped bases.
  if (baseURL) {
    baseURL = baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
  }
  return new Anthropic({ apiKey, baseURL }) as unknown as AnthropicClientLike;
}

/** Heuristic: classify an error as transient (worth retrying). */
function isTransientError(err: unknown): boolean {
  if (!err) return false;
  // Anthropic SDK errors expose `.status`; fetch errors expose name "TypeError".
  const status = (err as { status?: number }).status;
  if (typeof status === "number") {
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  const name = (err as { name?: string }).name;
  if (name === "TypeError" || name === "AbortError") return false;
  // Network-ish errors without status: assume transient.
  const msg = err instanceof Error ? err.message : String(err);
  return /ECONN|ETIMEDOUT|EAI_AGAIN|fetch failed|network/i.test(msg);
}

/** Translate unified TurnMessage[] → Anthropic wire messages. */
function toAnthropicMessages(messages: TurnMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      // User turns can be either pure text or a mix of text/tool_result.
      // Pre-flatten pure-text turns to a string for compactness on the wire.
      const allText = m.content.every((b) => b.type === "text");
      if (allText) {
        out.push({
          role: "user",
          content: m.content.map((b) => (b as TextBlock).text).join(""),
        });
        continue;
      }
      // Mixed or tool_result content. Anthropic accepts an array of blocks.
      out.push({
        role: "user",
        content: m.content
          .map((b) => mapBlockToAnthropicUserSide(b))
          .filter(
            (b): b is AnthropicToolResultBlock | AnthropicTextBlock =>
              b !== null,
          ) as AnthropicToolResultBlock[],
      });
    } else if (m.role === "tool") {
      // Tool results — Anthropic represents them as user-role messages
      // containing tool_result blocks. Collapse adjacent tool messages.
      out.push({
        role: "user",
        content: m.content
          .filter(
            (b): b is Extract<TurnContentBlock, { type: "tool_result" }> =>
              b.type === "tool_result",
          )
          .map((b) => ({
            type: "tool_result" as const,
            tool_use_id: b.tool_use_id,
            content: b.content,
            ...(b.is_error ? { is_error: true } : {}),
          })),
      });
    } else {
      // assistant
      const blocks: AnthropicAssistantBlock[] = m.content
        .filter(
          (b): b is TextBlock | ToolUseBlock =>
            b.type === "text" || b.type === "tool_use",
        )
        .map((b) =>
          b.type === "text"
            ? { type: "text", text: b.text }
            : {
                type: "tool_use",
                id: b.id,
                name: b.name,
                input: b.input,
              },
        );
      out.push({ role: "assistant", content: blocks });
    }
  }
  return out;
}

function mapBlockToAnthropicUserSide(
  b: TurnContentBlock,
): AnthropicTextBlock | AnthropicToolResultBlock | null {
  if (b.type === "text") return { type: "text", text: b.text };
  if (b.type === "tool_result") {
    return {
      type: "tool_result",
      tool_use_id: b.tool_use_id,
      content: b.content,
      ...(b.is_error ? { is_error: true } : {}),
    };
  }
  return null;
}

/** Translate an Anthropic response → unified TurnResult. */
function fromAnthropicResponse(resp: AnthropicResponse): TurnResult {
  const blocks = Array.isArray(resp.content) ? resp.content : [];
  const text = blocks
    .filter((b): b is AnthropicTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const toolCalls: ToolCallRequest[] = blocks
    .filter((b): b is AnthropicToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, input: b.input }));

  const rawAssistantBlocks: Array<TextBlock | ToolUseBlock> = blocks.map((b) =>
    b.type === "text"
      ? { type: "text", text: b.text }
      : { type: "tool_use", id: b.id, name: b.name, input: b.input },
  );

  const usage =
    resp.usage &&
    (typeof resp.usage.input_tokens === "number" ||
      typeof resp.usage.output_tokens === "number")
      ? {
          input: resp.usage.input_tokens ?? 0,
          output: resp.usage.output_tokens ?? 0,
        }
      : undefined;

  return {
    text,
    toolCalls,
    stopReason: resp.stop_reason,
    usage,
    rawAssistantBlocks,
  };
}

export class AnthropicBackend implements ReasoningBackend {
  readonly name = "anthropic";
  private readonly client: AnthropicClientLike;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicBackendOptions = {}) {
    this.client = opts.client ?? buildDefaultClient();
    this.model =
      opts.model ?? process.env.ANTHROPIC_LARGE_MODEL ?? DEFAULT_MODEL;
    this.maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  }

  async callTurn(opts: CallTurnOptions): Promise<TurnResult> {
    const wireMessages = toAnthropicMessages(opts.messages);
    const wireTools = toAnthropicTools(opts.tools);

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (opts.abortSignal?.aborted) {
        throw new Error("aborted");
      }
      try {
        const resp = await this.client.beta.messages.create({
          model: this.model,
          system: opts.systemPrompt || undefined,
          messages: wireMessages,
          tools: wireTools.length > 0 ? wireTools : undefined,
          max_tokens: this.maxTokens,
          betas: [ADVANCED_TOOL_USE_BETA],
        });
        return fromAnthropicResponse(resp);
      } catch (err) {
        lastError = err;
        if (attempt >= MAX_RETRIES || !isTransientError(err)) {
          throw err;
        }
        const delay = RETRY_BASE_DELAY_MS * attempt;
        logger.warn(
          `[native-reasoning][anthropic] transient error attempt ${attempt}/${MAX_RETRIES}, retrying in ${delay}ms: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
