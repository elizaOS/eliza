/**
 * Web search tool injection for Anthropic models (Path A).
 *
 * Adds Anthropic's server-side `web_search` tool to all generateText and
 * streamText calls when the model is Anthropic. This is zero-cost (no
 * separate API key needed) -- Anthropic handles it server-side.
 *
 * Works by monkey-patching the Vercel AI SDK's generateText/streamText
 * functions to inject the web_search tool whenever the model provider
 * is Anthropic and no tools are already present.
 *
 * Controlled by:
 *   ELIZA_WEB_SEARCH=0|false|off  — disable (default: enabled)
 */

import type { AgentRuntime } from "@elizaos/core";
import { logger, ModelType } from "@elizaos/core";

// ---------------------------------------------------------------------------
// Env gate (opt-out, enabled by default)
// ---------------------------------------------------------------------------

const ELIZA_WEB_SEARCH_ENABLED = (() => {
  const raw = process.env.ELIZA_WEB_SEARCH?.toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return true;
})();

// Prevent double-patching
let patched = false;
const installedRuntimes = new WeakSet<AgentRuntime>();

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

function isAnthropicRuntime(runtime: AgentRuntime): boolean {
  const modelsMap = runtime.models;
  if (modelsMap) {
    for (const key of [ModelType.TEXT_LARGE, "TEXT_LARGE"]) {
      const handlers = modelsMap.get(key);
      if (handlers?.[0]?.provider?.toLowerCase().includes("anthropic")) {
        return true;
      }
    }
  }

  // Fallback: env + character hints
  if (process.env.ANTHROPIC_API_KEY) {
    const char = runtime.character as Record<string, unknown> | undefined;
    const mp = char?.modelProvider;
    if (typeof mp === "string" && /anthropic/i.test(mp)) return true;
    const m = char?.model;
    if (typeof m === "string" && /claude|anthropic/i.test(m)) return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// AI SDK patch
// ---------------------------------------------------------------------------

function patchAiSdk(webSearchTool: unknown): void {
  if (patched) return;
  patched = true;

  let aiModule: Record<string, unknown>;
  try {
    aiModule = require("ai");
  } catch {
    logger.warn("[web-search] Could not require('ai') — skipping patch");
    return;
  }

  const wrapFn = (
    original: (...a: unknown[]) => unknown,
    name: string,
  ): ((...a: unknown[]) => unknown) => {
    const wrapped = function patchedAiFn(
      this: unknown,
      ...args: unknown[]
    ): unknown {
      if (args.length > 0 && args[0] && typeof args[0] === "object") {
        const params = args[0] as Record<string, unknown>;
        const model = params.model as { provider?: string } | undefined;
        const provider = model?.provider ?? "";

        if (
          provider.toLowerCase().includes("anthropic") &&
          (!params.tools || Object.keys(params.tools as object).length === 0)
        ) {
          args[0] = {
            ...params,
            tools: { web_search: webSearchTool },
          };
          logger.debug(
            `[web-search] Injected web_search tool into ${name} call`,
          );
        }
      }
      return original.apply(this, args);
    };
    // Preserve static properties
    for (const key of Object.getOwnPropertyNames(original)) {
      if (key !== "length" && key !== "name" && key !== "prototype") {
        try {
          const wrappedWithStatics = wrapped as typeof wrapped &
            Record<string, unknown>;
          const originalWithStatics = original as typeof original &
            Record<string, unknown>;
          wrappedWithStatics[key] = originalWithStatics[key];
        } catch {
          /* read-only */
        }
      }
    }
    return wrapped;
  };

  if (typeof aiModule.generateText === "function") {
    aiModule.generateText = wrapFn(
      aiModule.generateText as (...a: unknown[]) => unknown,
      "generateText",
    );
  }
  if (typeof aiModule.streamText === "function") {
    aiModule.streamText = wrapFn(
      aiModule.streamText as (...a: unknown[]) => unknown,
      "streamText",
    );
  }

  logger.info(
    "[web-search] Patched ai.generateText/streamText for Anthropic web_search auto-injection",
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enable Anthropic server-side web search for the given runtime.
 *
 * Call after plugins are registered and prompt optimizations installed.
 */
export function installAnthropicWebSearch(runtime: AgentRuntime): void {
  if (!ELIZA_WEB_SEARCH_ENABLED) {
    logger.info("[web-search] Disabled via ELIZA_WEB_SEARCH env var");
    return;
  }

  if (installedRuntimes.has(runtime)) return;
  installedRuntimes.add(runtime);

  if (!isAnthropicRuntime(runtime)) {
    logger.info(
      "[web-search] Non-Anthropic runtime — server-side web search skipped",
    );
    return;
  }

  // Load the web search server tool from @ai-sdk/anthropic
  let webSearchTool: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require("@ai-sdk/anthropic");
    const tools = sdk.anthropicTools ?? sdk.anthropic?.tools;
    if (tools?.webSearch_20260209) {
      webSearchTool = tools.webSearch_20260209();
    } else if (tools?.webSearch_20250305) {
      webSearchTool = tools.webSearch_20250305();
    }
  } catch (err) {
    logger.warn(
      `[web-search] @ai-sdk/anthropic not available: ${err instanceof Error ? err.message : err}`,
    );
    return;
  }

  if (!webSearchTool) {
    logger.warn(
      "[web-search] @ai-sdk/anthropic has no webSearch tool factory — upgrade @ai-sdk/anthropic",
    );
    return;
  }

  patchAiSdk(webSearchTool);

  logger.info(
    "[web-search] Anthropic server-side web_search enabled (zero-cost, no key required)",
  );
}
