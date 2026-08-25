/**
 * WEB_SEARCH — keyless inline general web search.
 *
 * Queries the keyless Parallel.ai search MCP (with an Exa fallback) — the same
 * backends the bundled opencode `websearch` tool uses — but INLINE this turn,
 * with no coding sub-agent spawn. Gives every runtime a fast, general web
 * search ("find me X", "latest on Y", "best Z", "who/what/where is …") that
 * needs no API key and no backing service, returning ranked results
 * (title / url / snippet) the model answers from.
 *
 * Sibling of {@link module:runtime/actions/web-fetch}: WEB_FETCH reads a value
 * from a URL you can name; WEB_SEARCH finds the pages when you can't. Routing
 * an open-ended lookup through a coding sub-agent is slow, re-spawns, and risks
 * leaking the weak model's tool-call markup — this answers it in one hop.
 *
 * Inline search is independently controlled by `ELIZA_INLINE_WEB_SEARCH`.
 * `ELIZA_WEB_SEARCH=0|false|off` remains a legacy master kill switch for all
 * web-search surfaces.
 *
 * @module runtime/actions/web-search
 */

import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
  searchKeylessWeb,
} from "@elizaos/core";

const DEFAULT_NUM_RESULTS = 6;

function readBooleanEnv(name: string): boolean | undefined {
  const raw = process.env[name]?.trim().toLowerCase();
  if (raw === undefined || raw.length === 0) return undefined;
  if (raw === "0" || raw === "false" || raw === "off" || raw === "no") {
    return false;
  }
  if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") {
    return true;
  }
  return undefined;
}

/**
 * Capability gate for the INLINE keyless web-search action. Inline WEB_SEARCH
 * is the default surface because it goes through Eliza action routing/audit.
 * Provider-native server-side search is an explicit opt-in with
 * `ELIZA_SERVER_WEB_SEARCH=1`; when that native surface is enabled, inline stays
 * off unless `ELIZA_INLINE_WEB_SEARCH` explicitly overrides it.
 */
export function isWebSearchEnabled(): boolean {
  const master = readBooleanEnv("ELIZA_WEB_SEARCH");
  if (master === false) return false;

  const inline = readBooleanEnv("ELIZA_INLINE_WEB_SEARCH");
  if (inline !== undefined) return inline;

  return readBooleanEnv("ELIZA_SERVER_WEB_SEARCH") !== true;
}

interface WebSearchParams {
  query?: string;
  numResults?: number;
}

function readParams(options: unknown): WebSearchParams {
  const params = (options as { parameters?: Record<string, unknown> })
    ?.parameters;
  if (!params || typeof params !== "object") return {};
  const query = params.query ?? params.q ?? params.objective;
  const rawNum = params.numResults ?? params.num_results;
  const n =
    typeof rawNum === "number"
      ? rawNum
      : Number.parseInt(String(rawNum ?? ""), 10);
  return {
    query: typeof query === "string" ? query.trim() : undefined,
    numResults: Number.isFinite(n) && n > 0 ? Math.min(n, 10) : undefined,
  };
}

/**
 * Extract the human-readable result text from an MCP `tools/call` response. The
 * body is either a JSON-RPC object or an SSE stream of `data:` lines; both wrap
 * the payload at `result.content[].text`. A JSON-RPC `error` envelope or a
 * tool-level `result.isError` is treated as a failure (returns undefined) — NOT
 * mistaken for a search result — so the caller falls back to the other provider
 * instead of handing the model an error string as if it were results.
 */
export const webSearch: Action & Record<string, unknown> = {
  name: "WEB_SEARCH",
  similes: [
    "SEARCH_WEB",
    "WEB_QUERY",
    "FIND_ONLINE",
    "SEARCH_INTERNET",
    "LOOKUP_ONLINE",
  ],
  // No context gate. An empty anyOf always passes the context-gate
  // (context-gates.ts), so this one general web tool is a candidate on EVERY
  // turn and is selected purely by semantic retrieval over its name / similes /
  // description. That makes it surface for any information-seeking query —
  // recommendations, facts, prices, news, current events — regardless of
  // whether Stage-1 labeled the turn "web" or "simple", with no keyword list.
  contexts: [],
  suppressInitialMessage: true,
  routingHint:
    "external/open-web info (news, public facts about people/places/products, 'latest on...', recommendations) -> WEB_SEARCH; a live NOW-value with a constructable endpoint (spot crypto/stock price, exchange rate, current weather) -> WEB_FETCH to that live API (api.coingecko.com, wttr.in/<city>?format=j1) — search-index snippets lag live values by minutes-to-hours, the endpoint is exact; a specific URL you can already name -> WEB_FETCH; do NOT use for the user's own notes/memories/private data -> MEMORY (action=search); for messages already in a channel -> MESSAGE (action=search); for the skill catalog -> SKILL",
  description:
    "Search the open web and answer from the results. " +
    "Use this for any question that needs current, real-world, or external information — news, current events, sports scores, recommendations ('best X', 'top Y'), facts about people, places, products, or companies, 'what/who/where/when is …', 'latest on …', 'how to …'. " +
    "For a live NOW-value (spot price, exchange rate, current weather) prefer WEB_FETCH to a live JSON endpoint — search snippets lag live values; use WEB_SEARCH for those only when no endpoint is constructable. " +
    "Returns ranked results (title, url, snippet) inline THIS turn. The snippets contain the answer — read them and answer the user directly and completely right now, citing a source; do not promise to look further. " +
    "Keyless and fast; no API key and no coding sub-agent required.",
  parameters: [
    {
      name: "query",
      description:
        "The search query in natural language (e.g. 'highest rated ramen shop in Tokyo').",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "numResults",
      description: "Optional number of results to return (default 6, max 10).",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "num_results",
      description:
        "Optional snake_case alias for numResults (default 6, max 10).",
      required: false,
      schema: { type: "number" },
    },
  ],

  validate: async (): Promise<boolean> => isWebSearchEnabled(),

  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: { [key: string]: unknown },
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const { query, numResults } = readParams(options);

    if (!query) {
      const text = "Missing required parameter 'query'.";
      callback?.({ text });
      return { text, success: false, data: { actionName: "WEB_SEARCH" } };
    }

    const n = numResults ?? DEFAULT_NUM_RESULTS;

    try {
      const result = await searchKeylessWeb(query, { resultCount: n });
      if (!result) {
        const text = `No web search results for "${query}".`;
        callback?.({ text });
        return {
          text,
          success: false,
          data: { actionName: "WEB_SEARCH", query },
        };
      }

      // Data-gathering action: the raw results are returned in the ActionResult
      // (below) for the RESPONSE_HANDLER to synthesize an answer from, and are
      // NOT delivered as a user-facing callback. Delivering them dumped the raw
      // search JSON/article text straight into the chat (chunked into several
      // messages) before the synthesized reply. Errors DO still call back.
      return {
        text: result.text,
        success: true,
        data: {
          actionName: "WEB_SEARCH",
          query,
          provider: result.provider,
          value: result.text,
          truncated: result.truncated,
        },
      };
    } catch (err) {
      // error-policy:J1 Action failures are returned to the planner for recovery.
      const message = err instanceof Error ? err.message : String(err);
      const text = `Web search failed for "${query}": ${message}`;
      callback?.({ text });
      return {
        text,
        success: false,
        data: { actionName: "WEB_SEARCH", query },
        error: message,
      };
    }
  },

  examples: [
    [
      {
        name: "{{user}}",
        content: {
          text: "what's the highest rated ramen shop in tokyo right now?",
        },
      },
      {
        name: "{{agent}}",
        content: {
          text: "",
          action: "WEB_SEARCH",
          actionParams: { query: "highest rated ramen shop in Tokyo" },
        },
      },
    ],
  ],
};
