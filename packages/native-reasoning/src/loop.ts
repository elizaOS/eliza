/**
 * runNativeReasoningLoop — single-call multi-tool reasoning loop.
 *
 * Bypasses eliza's classic shouldRespond/action-pick/format pipeline. The
 * loop dispatches each turn to the selected native-tool-use backend, which
 * returns a unified `TurnResult`. We execute any `tool_use` blocks in parallel and feed the
 * results back into the next turn until one of:
 *
 *   - the model emits a `tool_use` named `ignore` (silent — no callback)
 *   - the model emits zero tool_use blocks (final text → callback)
 *   - MAX_TURNS reached (callback "(hit reasoning limit, stopping)")
 *   - 90s wall-clock cap or 30s per-turn timeout
 *   - any uncaught error (brief callback + full stack logged)
 *
 * Backend wire-format translation lives in `src/backends/*`; the loop only
 * speaks the unified `TurnMessage` / `TurnResult` types.
 */

import type { HandlerCallback, IAgentRuntime, Memory } from "@elizaos/core";
import { logger } from "@elizaos/core";

import {
  AnthropicBackend,
  type AnthropicClientLike,
} from "./backends/anthropic.js";
import { type BackendName, selectBackend } from "./backends/index.js";
import type {
  ReasoningBackend,
  ToolCallRequest,
  ToolResultBlock,
  TurnMessage,
  TurnResult,
} from "./backends/types.js";
import { assembleSystemPrompt } from "./system-prompt.js";
import {
  buildToolsArray,
  type ToolHandlerResult,
  type ToolRegistry,
} from "./tool-schema.js";

const DEFAULT_MAX_TURNS = 12;
const DEFAULT_TOTAL_BUDGET_MS = 90_000;
const DEFAULT_PER_TURN_TIMEOUT_MS = 30_000;

export type { AnthropicClientLike } from "./backends/anthropic.js";

export interface RunOptions {
  /** Override the tool registry. Defaults to an empty registry. */
  registry?: ToolRegistry;
  /** Override the assembled system prompt (skip identity-file read entirely). */
  systemPrompt?: string;
  /** Override model name (forwarded to the Anthropic backend if selected). */
  model?: string;
  /** Backend/provider hint from character reasoning config. */
  provider?: "anthropic" | "openai" | "codex";
  /** Override max turns (default: env NATIVE_REASONING_MAX_TURNS or 12). */
  maxTurns?: number;
  /** Total wall-clock budget in ms (default: env NATIVE_REASONING_TOTAL_BUDGET_MS or 90000). */
  totalBudgetMs?: number;
  /** Per-turn API call timeout in ms (default: env NATIVE_REASONING_PER_TURN_TIMEOUT_MS or 30000). */
  perTurnTimeoutMs?: number;
  /**
   * Inject a mock Anthropic client (tests). When supplied, forces the
   * Anthropic backend even if env says otherwise — preserves the v1
   * test contract.
   */
  client?: AnthropicClientLike;
  /**
   * Inject a fully-formed backend (tests, advanced use). Takes precedence
   * over `client` and env.
   */
  backend?: ReasoningBackend;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const trimmed = raw.trim();
  const n = Number(trimmed);
  if (Number.isFinite(n) && Number.isInteger(n) && n > 0) return n;
  logger.warn(
    `[native-reasoning] invalid ${name}=${JSON.stringify(raw)}; using default ${fallback}`,
  );
  return fallback;
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function executeToolCall(
  call: ToolCallRequest,
  registry: ToolRegistry,
  runtime: IAgentRuntime,
  message: Memory,
): Promise<ToolResultBlock> {
  const entry = registry.get(call.name);
  if (!entry) {
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: `Unknown tool: ${call.name}`,
      is_error: true,
    };
  }
  try {
    const res: ToolHandlerResult = await entry.handler(
      call.input,
      runtime,
      message,
    );
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: res.content,
      ...(res.is_error === true ? { is_error: true } : {}),
    };
  } catch (err) {
    const stack =
      err instanceof Error ? (err.stack ?? err.message) : String(err);
    logger.error(`[native-reasoning] tool ${call.name} threw: ${stack}`);
    return {
      type: "tool_result",
      tool_use_id: call.id,
      content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }
}

function resolveBackend(options: RunOptions): ReasoningBackend {
  if (options.backend) return options.backend;
  if (options.client) {
    // Tests / explicit Anthropic-client injection: force Anthropic backend.
    return new AnthropicBackend({
      client: options.client,
      ...(options.model ? { model: options.model } : {}),
    });
  }
  const backend =
    options.provider === "anthropic" || options.provider === "codex"
      ? (options.provider satisfies BackendName)
      : undefined;
  if (options.provider === "openai") {
    logger.warn(
      "[native-reasoning] provider=openai requested but no OpenAI backend is registered yet; using default backend",
    );
  }
  return selectBackend({
    backend,
    anthropic: options.model ? { model: options.model } : undefined,
  });
}

/**
 * Run the native-reasoning loop end-to-end. Resolves once the loop is done
 * (callback already fired, or `ignore` short-circuit, or limits hit).
 */
export async function runNativeReasoningLoop(
  runtime: IAgentRuntime,
  message: Memory,
  callback: HandlerCallback,
  options: RunOptions = {},
): Promise<void> {
  const userText = (message.content?.text ?? "").trim();
  if (!userText) {
    // Nothing to reason about. Stay silent.
    return;
  }

  const registry: ToolRegistry = options.registry ?? new Map();
  const tools = buildToolsArray(registry);
  const maxTurns =
    options.maxTurns ?? envInt("NATIVE_REASONING_MAX_TURNS", DEFAULT_MAX_TURNS);
  const totalBudgetMs =
    options.totalBudgetMs ??
    envInt("NATIVE_REASONING_TOTAL_BUDGET_MS", DEFAULT_TOTAL_BUDGET_MS);
  const perTurnTimeoutMs =
    options.perTurnTimeoutMs ??
    envInt("NATIVE_REASONING_PER_TURN_TIMEOUT_MS", DEFAULT_PER_TURN_TIMEOUT_MS);
  logger.info(
    `[native-reasoning] budgets resolved: total=${totalBudgetMs}ms perTurn=${perTurnTimeoutMs}ms maxTurns=${maxTurns}`,
  );

  const backend = resolveBackend(options);

  let systemPrompt: string;
  try {
    systemPrompt =
      options.systemPrompt ?? (await assembleSystemPrompt(runtime, message));
  } catch (err) {
    logger.error(
      `[native-reasoning] failed to assemble system prompt: ${
        err instanceof Error ? err.stack : String(err)
      }`,
    );
    systemPrompt = "";
  }

  const messages: TurnMessage[] = [
    { role: "user", content: [{ type: "text", text: userText }] },
  ];

  const startedAt = Date.now();

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= totalBudgetMs) {
        logger.warn(
          `[native-reasoning] hit total budget (${totalBudgetMs}ms) at turn ${turn}`,
        );
        await callback({
          text: "(reasoning timed out, stopping)",
          attachments: [],
        });
        return;
      }

      let result: TurnResult;
      try {
        const turnController = new AbortController();
        result = await withTimeout(
          backend.callTurn({
            systemPrompt,
            messages,
            tools,
            abortSignal: turnController.signal,
          }),
          perTurnTimeoutMs,
          `native-reasoning turn ${turn}`,
          () => turnController.abort(),
        );
      } catch (err) {
        logger.error(
          `[native-reasoning] turn ${turn} backend error: ${
            err instanceof Error ? (err.stack ?? err.message) : String(err)
          }`,
        );
        await callback({
          text: "(reasoning error, please retry)",
          attachments: [],
        });
        return;
      }

      // `ignore` short-circuit: silent return, no callback.
      const ignoreCall = result.toolCalls.find((c) => c.name === "ignore");
      if (ignoreCall) {
        logger.debug("[native-reasoning] model called ignore — stopping");
        return;
      }

      if (result.toolCalls.length === 0) {
        // Terminal turn: emit text and stop.
        const text = result.text.trim();
        if (text.length > 0) {
          await callback({ text, attachments: [] });
        }
        return;
      }

      // Echo assistant turn back into history (preserve original block order),
      // then execute tools in parallel and append a tool message.
      messages.push({
        role: "assistant",
        content: result.rawAssistantBlocks,
      });

      const results = await Promise.all(
        result.toolCalls.map((tc) =>
          executeToolCall(tc, registry, runtime, message),
        ),
      );
      messages.push({ role: "tool", content: results });
    }

    // Fell through MAX_TURNS without a final text block.
    logger.warn(
      `[native-reasoning] hit MAX_TURNS (${maxTurns}) without final text`,
    );
    await callback({
      text: "(hit reasoning limit, stopping)",
      attachments: [],
    });
  } catch (err) {
    logger.error(
      `[native-reasoning] uncaught loop error: ${
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      }`,
    );
    try {
      await callback({
        text: "(internal reasoning error, please retry)",
        attachments: [],
      });
    } catch {
      // callback errors are already logged above by the runtime — swallow.
    }
  }
}
