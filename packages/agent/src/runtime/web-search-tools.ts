/**
 * Server-side web search injection for every provider that supports it.
 *
 * Monkey-patches the Vercel AI SDK's `generateText`/`streamText` to attach a
 * provider's native, server-executed web search tool whenever a call targets a
 * supporting provider and carries no tools of its own. Server-side search is
 * zero-plumbing: the provider runs the search and grounds its own answer — no
 * Tavily/Serper key, no extra application round-trips.
 *
 * Supported providers (matched against the AI SDK `model.provider` string):
 *   anthropic.messages    → @ai-sdk/anthropic  webSearch_*
 *   google.generative-ai  → @ai-sdk/google     googleSearch
 *   openai.responses      → @ai-sdk/openai      webSearch
 *
 * OpenAI's Chat Completions API (`openai.chat`) silently drops provider tools,
 * so it is intentionally not matched here — the OpenAI plugin routes text
 * through the Responses API (`openai.responses`) when the endpoint is genuine
 * OpenAI, which is what makes the `openai.responses` branch fire.
 *
 * Controlled by:
 *   ELIZA_WEB_SEARCH=0|false|off  — disable (default: enabled)
 */

import { createRequire } from "node:module";
import { logger } from "@elizaos/core";

const require = createRequire(import.meta.url);

const ENABLED = (() => {
  const raw = process.env.ELIZA_WEB_SEARCH?.toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
})();

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

interface ProviderWebSearch {
  /** Stable label, also the cache key. */
  label: string;
  /** Key the tool is injected under in `params.tools`. */
  toolKey: string;
  /** True when this entry handles the given (lowercased) `model.provider`. */
  matches: (provider: string) => boolean;
  /** Builds the provider-defined tool, or null when its SDK/tool is absent. */
  build: () => unknown;
}

const PROVIDERS: ProviderWebSearch[] = [
  {
    label: "anthropic",
    toolKey: "web_search",
    matches: (p) => p.startsWith("anthropic"),
    build: () => {
      const sdk = require("@ai-sdk/anthropic");
      const tools = sdk.anthropicTools ?? sdk.anthropic?.tools;
      const factory = tools?.webSearch_20260209 ?? tools?.webSearch_20250305;
      return factory ? factory() : null;
    },
  },
  {
    label: "google",
    toolKey: "google_search",
    matches: (p) => p.startsWith("google"),
    build: () => {
      const sdk = require("@ai-sdk/google");
      const tools = sdk.googleTools ?? sdk.google?.tools;
      const factory = tools?.googleSearch;
      return factory ? factory({}) : null;
    },
  },
  {
    label: "openai",
    toolKey: "web_search",
    // Only the Responses API executes provider tools; chat completions drops them.
    matches: (p) => p === "openai.responses",
    build: () => {
      const sdk = require("@ai-sdk/openai");
      const tools = sdk.openaiTools ?? sdk.openai?.tools;
      const factory = tools?.webSearch ?? tools?.webSearchPreview;
      return factory ? factory({}) : null;
    },
  },
];

// Built tools are memoized per provider. A cached `null` means "SDK or tool
// unavailable" so we never re-require a missing package on every call.
const toolCache = new Map<string, unknown>();

function toolFor(entry: ProviderWebSearch): unknown {
  if (toolCache.has(entry.label)) return toolCache.get(entry.label);
  let tool: unknown = null;
  try {
    tool = entry.build();
    if (!tool) {
      logger.warn(
        `[web-search] ${entry.label}: SDK present but no web search factory — upgrade @ai-sdk/${entry.label}`,
      );
    }
  } catch (err) {
    logger.debug(
      `[web-search] ${entry.label}: SDK unavailable (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  toolCache.set(entry.label, tool);
  return tool;
}

// ---------------------------------------------------------------------------
// AI SDK patch
// ---------------------------------------------------------------------------

let patched = false;

/**
 * Skip injection when the caller owns the tool surface or constrains output.
 * Structured/JSON calls are schema-bound classifications where a search
 * round-trip fights the grammar and adds latency for no benefit.
 */
function shouldSkip(params: Record<string, unknown>): boolean {
  const tools = params.tools as object | undefined;
  if (tools && Object.keys(tools).length > 0) return true;
  if (params.output) return true;
  const rf = params.responseFormat as { type?: string } | undefined;
  if (rf?.type && rf.type !== "text") return true;
  return false;
}

function wrapFn(
  original: (...a: unknown[]) => unknown,
  name: string,
): (...a: unknown[]) => unknown {
  const wrapped = function patchedAiFn(
    this: unknown,
    ...args: unknown[]
  ): unknown {
    if (args.length > 0 && args[0] && typeof args[0] === "object") {
      const params = args[0] as Record<string, unknown>;
      const provider = (params.model as { provider?: string } | undefined)
        ?.provider;
      if (provider && !shouldSkip(params)) {
        const entry = PROVIDERS.find((e) => e.matches(provider.toLowerCase()));
        const tool = entry ? toolFor(entry) : null;
        if (entry && tool) {
          args[0] = { ...params, tools: { [entry.toolKey]: tool } };
          logger.debug(
            `[web-search] Injected ${entry.label} web search into ${name} (${provider})`,
          );
        }
      }
    }
    return original.apply(this, args);
  };
  // Preserve static properties on the original SDK function.
  for (const key of Object.getOwnPropertyNames(original)) {
    if (key !== "length" && key !== "name" && key !== "prototype") {
      try {
        (wrapped as unknown as Record<string, unknown>)[key] = (
          original as unknown as Record<string, unknown>
        )[key];
      } catch {
        /* read-only */
      }
    }
  }
  return wrapped;
}

function patchAiSdk(): void {
  if (patched) return;

  let aiModule: Record<string, unknown>;
  try {
    aiModule = require("ai");
  } catch {
    logger.warn("[web-search] Could not require('ai') — skipping patch");
    return;
  }

  patched = true;

  for (const name of ["generateText", "streamText"] as const) {
    if (typeof aiModule[name] === "function") {
      aiModule[name] = wrapFn(
        aiModule[name] as (...a: unknown[]) => unknown,
        name,
      );
    }
  }

  logger.info(
    "[web-search] Patched ai.generateText/streamText for server-side web search auto-injection",
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Enable server-side web search across all supported providers.
 *
 * The patch is global and idempotent — provider selection happens per call
 * from the model's `provider` string, so a single install covers every agent
 * and every provider on the runtime. Call after plugins are registered.
 */
export function installServerSideWebSearch(): void {
  if (!ENABLED) {
    logger.info("[web-search] Disabled via ELIZA_WEB_SEARCH env var");
    return;
  }
  patchAiSdk();
}
