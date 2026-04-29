/**
 * Hosted web search action.
 *
 * Prefers Eliza Cloud hosted Google-grounded Gemini search when cloud tooling
 * is configured. Falls back to the Brave Search API when cloud search is not
 * available locally.
 */

import type { Action, HandlerOptions, Memory, State } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { hasOwnerAccess } from "../security/access.js";
import {
  type HostedSearchResponse,
  isHostedCloudToolingConfigured,
  searchHostedCloudWeb,
} from "../services/hosted-tools.js";
import { hasContextSignalSyncForKey } from "./context-signal.js";

// ---------------------------------------------------------------------------
// Brave Search API types
// ---------------------------------------------------------------------------

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
  query?: {
    original?: string;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBraveApiKey(runtime: unknown): string | undefined {
  // 1. Direct env var
  if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;

  // 2. Runtime config
  const rt = runtime as { getSetting?: (...args: unknown[]) => unknown };
  const fromConfig = rt.getSetting?.("BRAVE_API_KEY");
  if (typeof fromConfig === "string" && fromConfig) return fromConfig;

  return undefined;
}

function hasWebSearchContextSignal(
  message: Memory,
  state: State | undefined,
): boolean {
  return hasContextSignalSyncForKey(message, state, "web_search");
}

function resolveMaxResults(runtime: unknown): number {
  const rt = runtime as { getSetting?: (...args: unknown[]) => unknown };
  const raw = rt.getSetting?.("WEB_SEARCH_MAX_RESULTS");
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n > 0 && n <= 20) return n;
  }
  return 5;
}

function formatHostedResults(result: HostedSearchResponse): string {
  const citations = result.results
    .map((entry, index) => `${index + 1}. ${entry.title}\n   ${entry.url}`)
    .join("\n");

  return [
    `Search answer for "${result.query}":`,
    "",
    result.answer,
    citations ? `\nCitations:\n${citations}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function braveSearch(
  query: string,
  apiKey: string,
  maxResults: number,
  timeoutMs = 10_000,
): Promise<BraveSearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(
        `Brave Search API returned ${response.status}: ${response.statusText}`,
      );
    }

    const data = (await response.json()) as BraveSearchResponse;
    return data.web?.results ?? [];
  } finally {
    clearTimeout(timer);
  }
}

function formatResults(results: BraveSearchResult[], query: string): string {
  if (results.length === 0) {
    return `No web search results found for "${query}".`;
  }

  const lines = results.map((r, i) => {
    const age = r.age ? ` (${r.age})` : "";
    return `${i + 1}. **${r.title}**${age}\n   ${r.url}\n   ${r.description}`;
  });

  return [`Web search results for "${query}":`, "", ...lines].join("\n");
}

// ---------------------------------------------------------------------------
// Action definition
// ---------------------------------------------------------------------------

export const webSearchAction: Action = {
  name: "WEB_SEARCH",
  similes: [
    "SEARCH_WEB",
    "BRAVE_SEARCH",
    "INTERNET_SEARCH",
    "SEARCH_INTERNET",
    "LOOKUP_WEB",
    "GOOGLE",
    "SEARCH",
  ],
  description:
    "Search the web for current information using Eliza Cloud hosted Google search when available, with Brave Search as a local fallback. " +
    "Use when you need real-time or recent information that may not be in your training data.",

  validate: async (runtime, message, state) => {
    if (!(await hasOwnerAccess(runtime, message))) return false;
    const hasHostedSearch = isHostedCloudToolingConfigured(process.env);
    const braveKey = resolveBraveApiKey(runtime);
    if (!hasHostedSearch && !braveKey) return false;
    return hasWebSearchContextSignal(message, state);
  },

  handler: async (runtime, message, _state, options) => {
    if (!(await hasOwnerAccess(runtime, message))) {
      return {
        text: "Permission denied: only the owner may run web search.",
        success: false,
        values: { success: false, error: "PERMISSION_DENIED" },
        data: { actionName: "WEB_SEARCH" },
      };
    }

    const braveApiKey = resolveBraveApiKey(runtime);
    const hasHostedSearch = isHostedCloudToolingConfigured(process.env);
    if (!hasHostedSearch && !braveApiKey) {
      return {
        text: "Web search is not configured. Connect Eliza Cloud hosted tools or set BRAVE_API_KEY to enable it.",
        success: false,
        values: { success: false, error: "NO_API_KEY" },
        data: { actionName: "WEB_SEARCH" },
      };
    }

    // Extract query from action parameters or message content
    const params = (options as HandlerOptions | undefined)?.parameters as
      | { query?: string }
      | undefined;
    let query = params?.query;

    if (!query) {
      // Fall back to extracting from message text
      const text =
        typeof message?.content === "string"
          ? message.content
          : ((message?.content as { text?: string })?.text ?? "");
      // Strip common prefixes
      query = text
        .replace(
          /^(search\s+(the\s+)?web\s+(for|about)|web\s+search|search|look\s+up|google)\s*/i,
          "",
        )
        .trim();
    }

    if (!query) {
      return {
        text: "Please provide a search query.",
        success: false,
        values: { success: false, error: "EMPTY_QUERY" },
        data: { actionName: "WEB_SEARCH" },
      };
    }

    const maxResults = resolveMaxResults(runtime);

    try {
      if (hasHostedSearch) {
        logger.info(
          `[web-search] Hosted search: "${query}" (max ${maxResults})`,
        );
        const hostedResult = await searchHostedCloudWeb({
          maxResults,
          query,
        });
        return {
          text: formatHostedResults(hostedResult),
          success: true,
          values: {
            success: true,
            provider: hostedResult.provider,
            resultCount: hostedResult.results.length,
          },
          data: {
            actionName: "WEB_SEARCH",
            ...hostedResult,
          },
        };
      }

      if (!braveApiKey) {
        throw new Error(
          "Hosted search is unavailable and BRAVE_API_KEY is not configured.",
        );
      }

      logger.info(`[web-search] Brave search: "${query}" (max ${maxResults})`);
      const results = await braveSearch(query, braveApiKey, maxResults);
      const formatted = formatResults(results, query);

      return {
        text: formatted,
        success: true,
        values: {
          success: true,
          resultCount: results.length,
        },
        data: {
          actionName: "WEB_SEARCH",
          query,
          results: results.map((r) => ({
            title: r.title,
            url: r.url,
            description: r.description,
          })),
        },
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (hasHostedSearch && braveApiKey) {
        try {
          logger.warn(
            `[web-search] Hosted search failed, falling back to Brave: ${errMsg}`,
          );
          const fallbackResults = await braveSearch(
            query,
            braveApiKey,
            maxResults,
          );
          return {
            text: formatResults(fallbackResults, query),
            success: true,
            values: {
              success: true,
              provider: "brave",
              resultCount: fallbackResults.length,
            },
            data: {
              actionName: "WEB_SEARCH",
              provider: "brave",
              query,
              results: fallbackResults.map((result) => ({
                title: result.title,
                url: result.url,
                description: result.description,
              })),
            },
          };
        } catch (fallbackError) {
          const fallbackMessage =
            fallbackError instanceof Error
              ? fallbackError.message
              : String(fallbackError);
          logger.warn(
            `[web-search] Hosted and Brave search failed: ${fallbackMessage}`,
          );
          return {
            text: `Web search failed: ${fallbackMessage}`,
            success: false,
            values: { success: false, error: "SEARCH_FAILED" },
            data: { actionName: "WEB_SEARCH", query },
          };
        }
      }

      logger.warn(`[web-search] Search failed: ${errMsg}`);

      return {
        text: `Web search failed: ${errMsg}`,
        success: false,
        values: { success: false, error: "SEARCH_FAILED" },
        data: { actionName: "WEB_SEARCH", query },
      };
    }
  },

  parameters: [
    {
      name: "query",
      description:
        "The search query to run against the web. Supply what the user wants to learn about.",
      required: true,
      schema: { type: "string" as const },
    },
  ],
  examples: [
    [
      {
        name: "user",
        content: { text: "Search the web for latest Solana validator changes" },
      },
      {
        name: "assistant",
        content: {
          text: 'Web search results for "latest Solana validator changes":\n\n1. **Solana Validator Update v2.2** ...',
          action: "WEB_SEARCH",
        },
      },
    ],
    [
      {
        name: "user",
        content: { text: "What is the current price of ETH?" },
      },
      {
        name: "assistant",
        content: {
          text: 'Web search results for "current ETH price":\n\n1. **Ethereum Price Today** ...',
          action: "WEB_SEARCH",
        },
      },
    ],
  ],
};
