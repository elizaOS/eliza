/**
 * WEB_SEARCH exposes the same keyless MCP search path to coding-only agents that
 * the full agent runtime uses: Parallel is primary, Exa is fallback. Results are
 * bounded before they enter the planner loop and no query text is logged.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import {
  failureToActionResult,
  readNumberParam,
  readStringParam,
  successActionResult,
} from "../lib/format.js";
import { guardedTextHttpRequest } from "../lib/web-http.js";
import { CODING_TOOLS_CONTEXTS } from "../types.js";

const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const WEB_SEARCH_READ_BYTES = 256 * 1024;
const WEB_SEARCH_RESULT_CHARS = 4_000;
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

function parseMcpResultText(body: string): string | undefined {
  const fromPayload = (payload: string): string | undefined => {
    const trimmed = payload.trim();
    if (!trimmed.startsWith("{")) return undefined;
    try {
      const data = JSON.parse(trimmed) as {
        error?: unknown;
        result?: { isError?: boolean; content?: Array<{ text?: string }> };
      };
      if (data.error || data.result?.isError) return undefined;
      const text = data.result?.content?.find((item) => item.text)?.text;
      return text && text.trim().length > 0 ? text : undefined;
    } catch {
      return undefined;
    }
  };
  const direct = fromPayload(body);
  if (direct) return direct;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const parsed = fromPayload(line.slice(6));
    if (parsed) return parsed;
  }
  return undefined;
}

async function callSearchMcp(
  url: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<string | undefined> {
  const response = await guardedTextHttpRequest(url, {
    method: "POST",
    maxBytes: WEB_SEARCH_READ_BYTES,
    headers: { Accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });
  if (!response.ok) return undefined;
  return parseMcpResultText(response.text);
}

export const webSearchAction: Action = {
  name: "WEB_SEARCH",
  contexts: [...CODING_TOOLS_CONTEXTS],
  contextGate: { anyOf: [...CODING_TOOLS_CONTEXTS] },
  roleGate: { minRole: "ADMIN" },
  similes: ["SEARCH_WEB", "WEB_QUERY", "FIND_ONLINE", "SEARCH_INTERNET"],
  description:
    "Search the open web for current or external information using keyless MCP search. Uses Parallel first and Exa fallback, returning bounded ranked result text.",
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
    callback?: HandlerCallback,
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
      let provider = "parallel";
      let results = await callSearchMcp(PARALLEL_MCP_URL, "web_search", {
        objective: query,
        search_queries: [query],
      });
      if (!results) {
        provider = "exa";
        results = await callSearchMcp(EXA_MCP_URL, "web_search_exa", {
          query,
          type: "auto",
          numResults,
          livecrawl: "fallback",
        });
      }
      if (!results) {
        const result = failureToActionResult(
          { reason: "no_match", message: "search returned no usable results" },
          { action: "WEB_SEARCH", provider: null },
        );
        if (callback)
          await callback({ text: result.text, source: "coding-tools" });
        return result;
      }

      const value =
        results.length > WEB_SEARCH_RESULT_CHARS
          ? `${results.slice(0, WEB_SEARCH_RESULT_CHARS)}\n[truncated]`
          : results;
      return successActionResult(value, {
        action: "WEB_SEARCH",
        provider,
        result_chars: value.length,
        truncated: results.length > WEB_SEARCH_RESULT_CHARS,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const result = failureToActionResult(
        { reason: "io_error", message },
        { action: "WEB_SEARCH" },
      );
      if (callback)
        await callback({ text: result.text, source: "coding-tools" });
      return result;
    }
  },
};
