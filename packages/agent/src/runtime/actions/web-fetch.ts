/**
 * WEB_FETCH — keyless inline HTTP GET of a public URL or data API.
 *
 * Gives every runtime (not just Anthropic, which gets server-side web_search
 * via {@link installAnthropicWebSearch}) an inline live-info capability that
 * needs no API key and no backing service. Because its similes include
 * `LOOKUP_WEB` / `WEB_LOOKUP`, the core router's `findWebLookupActionName`
 * picks it up with no core change, so non-Anthropic models can answer
 * live-info questions inline instead of force-delegating to a coding agent.
 *
 * Always available (validate => true). The fetch itself is hardened by the
 * shared SSRF-guarded, https-only, GET-only helper.
 *
 * @module runtime/actions/web-fetch
 */

import {
  type Action,
  type ActionResult,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import { performGuardedHttpGet } from "../custom-actions.ts";

/** Max characters of fetched text we return when no extract path matches. */
const WEB_FETCH_SNIPPET_CHARS = 4_000;

interface WebFetchParams {
  url?: string;
  extract?: string;
}

function readParams(options: unknown): WebFetchParams {
  const params = (options as { parameters?: Record<string, unknown> })
    ?.parameters;
  if (!params || typeof params !== "object") return {};
  const url = params.url;
  const extract = params.extract;
  return {
    url: typeof url === "string" ? url.trim() : undefined,
    extract: typeof extract === "string" ? extract.trim() : undefined,
  };
}

/**
 * Resolve a dotted JSON path (e.g. `data.price` or `items.0.name`) against a
 * parsed JSON value. Returns undefined when any segment is missing.
 */
function resolveJsonPath(root: unknown, path: string): unknown {
  let current: unknown = root;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Apply the optional `extract` instruction: when the body parses as JSON and
 * `extract` is a dotted path that resolves, return that field; otherwise fall
 * back to a truncated text snippet of the raw body.
 */
function extractValue(body: string, extract: string | undefined): string {
  if (extract) {
    try {
      const parsed: unknown = JSON.parse(body);
      const resolved = resolveJsonPath(parsed, extract);
      if (resolved !== undefined) return stringifyValue(resolved);
    } catch {
      // Body was not JSON, or extract did not resolve — fall through to snippet.
    }
  }
  return body.slice(0, WEB_FETCH_SNIPPET_CHARS);
}

export const webFetch: Action & Record<string, unknown> = {
  name: "WEB_FETCH",
  similes: ["LOOKUP_WEB", "WEB_LOOKUP", "FETCH_URL", "HTTP_GET", "GET_URL"],
  suppressInitialMessage: true,
  description:
    "Fetch the contents of a public https URL or JSON data API and return the result inline. " +
    "Use for live information — current data, status pages, public REST/JSON endpoints — when you already know (or can construct) the exact URL. " +
    "No API key required. Requests are https-only, GET-only, and SSRF-guarded (internal/private hosts are blocked).",

  parameters: [
    {
      name: "url",
      description:
        "The absolute https URL to fetch (e.g. https://api.example.com/v1/price).",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "extract",
      description:
        "Optional dotted JSON path selecting which field to return when the body is JSON (e.g. 'data.amount'). Omit to return a text snippet of the body.",
      required: false,
      schema: { type: "string" },
    },
  ],

  validate: async (): Promise<boolean> => true,

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const { url, extract } = readParams(options);

    if (!url) {
      const text = "Missing required parameter 'url'.";
      callback?.({ text });
      return { text, success: false, data: { actionName: "WEB_FETCH" } };
    }

    try {
      new URL(url);
    } catch {
      const text = `Not a valid URL: ${url}`;
      callback?.({ text });
      return { text, success: false, data: { actionName: "WEB_FETCH", url } };
    }
    try {
      const result = await performGuardedHttpGet(url, {
        headers: { Accept: "application/json, text/plain, */*" },
      });

      if (result.blocked) {
        const text = `Refusing to fetch ${url}: blocked host or disallowed redirect.`;
        logger.warn(`[web-fetch] blocked ${url}`);
        callback?.({ text });
        return { text, success: false, data: { actionName: "WEB_FETCH", url } };
      }

      if (!result.ok) {
        const text = `Fetch failed for ${url}: HTTP ${result.status}.`;
        callback?.({ text });
        return {
          text,
          success: false,
          data: { actionName: "WEB_FETCH", url, status: result.status },
        };
      }

      const value = extractValue(result.text, extract);
      const content: Content = {
        text: value,
        actions: ["WEB_FETCH"],
        data: { actionName: "WEB_FETCH", url, value },
      };
      callback?.(content);
      return {
        text: value,
        success: true,
        data: { actionName: "WEB_FETCH", url, value },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[web-fetch] error fetching ${url}: ${message}`);
      const text = `Fetch failed for ${url}: ${message}`;
      callback?.({ text });
      return {
        text,
        success: false,
        data: { actionName: "WEB_FETCH", url },
        error: message,
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "What does https://api.example.com/v1/status return?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "Fetching that endpoint now:",
          action: "WEB_FETCH",
          actionParams: { url: "https://api.example.com/v1/status" },
        },
      },
    ],
  ],
};
