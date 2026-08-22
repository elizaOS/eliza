/**
 * WEB_SEARCH exposes the same keyless MCP search path to coding-only agents that
 * the full agent runtime uses: Parallel is primary, Exa is fallback. Complete
 * provider results enter the planner loop and no query text is logged.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import { searchKeylessWeb } from "@elizaos/core";
import {
  failureToActionResult,
  readNumberParam,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import { CODING_TOOLS_CONTEXTS } from "../types.js";

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
 * Capability kill switches, mirroring the agent-runtime WEB_SEARCH gate:
 * `ELIZA_WEB_SEARCH=0|false|off` is the master kill switch, and
 * `ELIZA_INLINE_WEB_SEARCH` explicitly enables/disables the inline keyless
 * surface. Checked at `validate` AND at handler entry so a disabled
 * capability never calls the MCP providers through any invocation path.
 */
export function isCodingWebSearchEnabled(): boolean {
  const master = readBooleanEnv("ELIZA_WEB_SEARCH");
  if (master === false) return false;
  const inline = readBooleanEnv("ELIZA_INLINE_WEB_SEARCH");
  if (inline !== undefined) return inline;
  return true;
}

export const webSearchAction: Action = {
  name: "WEB_SEARCH",
  // "web" belongs alongside the coding contexts: stage-1's routing vocabulary
  // names `web` for live-lookup turns, and an action literally named
  // WEB_SEARCH/WEB_FETCH being unreachable from the `web` context left
  // candidate-less web turns with no web tool on the planner surface
  // (observed live: a weather+note composite surfaced only the CONTACT
  // family).
  contexts: [...CODING_TOOLS_CONTEXTS, "web"],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS, "web"] },
  roleGate: { minRole: "ADMIN" },
  similes: ["SEARCH_WEB", "WEB_QUERY", "FIND_ONLINE", "SEARCH_INTERNET"],
  routingHint:
    "open-ended external info (news, public facts, 'latest on...', recommendations, pages to discover) -> WEB_SEARCH; a live NOW-value with a constructable endpoint (spot crypto/stock price, exchange rate, current weather) -> WEB_FETCH to that live API (api.coingecko.com/api/v3/simple/price, wttr.in/<city>?format=j1) — search-index snippets lag live values by minutes-to-hours, the endpoint is exact and fresh",
  description:
    "Search the open web for current or external information using keyless MCP search. Uses Parallel first and Exa fallback, returning complete ranked result text. For a live NOW-value (spot price, exchange rate, current weather) prefer WEB_FETCH to a live JSON endpoint — search snippets lag live values.",
  parameters: [
    {
      name: "query",
      description: "Search query in natural language.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "numResults",
      description: "Optional number of results to request, default 6, max 10.",
      required: false,
      schema: { type: "number" },
    },
  ],
  validate: async () => isCodingWebSearchEnabled(),
  handler: async (
    _runtime: IAgentRuntime,
    _message: Memory,
    _state?: State,
    options?: unknown,
    _callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    if (!isCodingWebSearchEnabled()) {
      return failureToActionResult({
        reason: "disabled",
        message:
          "WEB_SEARCH is disabled via ELIZA_WEB_SEARCH / ELIZA_INLINE_WEB_SEARCH",
      });
    }
    const query =
      readStringParam(options, "query") ??
      readStringParam(options, "q") ??
      readStringParam(options, "objective");
    if (!query?.trim()) {
      return failureToActionResult({
        reason: "missing_param",
        message: "query is required",
      });
    }
    const requested = readNumberParam(options, "numResults");
    const numResults =
      requested && requested > 0
        ? Math.min(10, Math.floor(requested))
        : DEFAULT_NUM_RESULTS;

    try {
      const result = await searchKeylessWeb(query, { resultCount: numResults });
      if (!result) {
        const result = failureToActionResult(
          { reason: "no_match", message: "search returned no usable results" },
          { action: "WEB_SEARCH", provider: null },
        );
        return result;
      }

      return successActionResult(result.text, {
        action: "WEB_SEARCH",
        provider: result.provider,
        result_chars: result.text.length,
        truncated: result.truncated,
      });
    } catch (error) {
      // error-policy:J1 Action failures are returned to the planner for recovery.
      const message = error instanceof Error ? error.message : String(error);
      const result = failureToActionResult(
        { reason: "io_error", message },
        { action: "WEB_SEARCH" },
      );
      return result;
    }
  },
};
