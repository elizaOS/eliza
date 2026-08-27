// Keyless MCP web search for hosted agents: Parallel is primary, Exa is
// fallback. Mirrors the runtime's coding-tools WEB_SEARCH path so a hosted
// agent without a Google/Gemini key still has working web search instead of a
// service that throws at initialize. Plain fetch (Worker-compatible), bounded
// response reads, and no query text in logs.
import { logger } from "@elizaos/core/edge";

const PARALLEL_MCP_URL = "https://search.parallel.ai/mcp";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const MCP_TIMEOUT_MS = 20_000;

export interface KeylessSearchResult {
  answer: string;
  provider: "parallel" | "exa";
}

/**
 * Extract the tool-result text from an MCP tools/call response body, which is
 * either a plain JSON-RPC envelope or an SSE stream of `data:` lines carrying
 * the same envelope shape.
 */
export function parseMcpResultText(body: string): string | undefined {
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
      // error-policy:J3 untrusted-input sanitizing — a non-JSON payload line is
      // an explicit "no result here", never a fabricated result.
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MCP_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });
    if (!response.ok) return undefined;
    const body = await response.text();
    return parseMcpResultText(body);
  } catch {
    // error-policy:J4 explicit user-facing degrade — an unreachable/timed-out
    // provider yields undefined so the caller can try the fallback provider
    // and ultimately throw a real "all providers failed" error.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run a keyless web search: Parallel first, Exa on miss. Throws when both
 * providers fail so a broken pipeline surfaces instead of returning empty.
 */
export async function executeKeylessMcpSearch(
  query: string,
  maxResults: number,
): Promise<KeylessSearchResult> {
  const parallel = await callSearchMcp(PARALLEL_MCP_URL, "web_search", {
    objective: query,
    search_queries: [query],
  });
  if (parallel) {
    return { answer: parallel, provider: "parallel" };
  }
  const exa = await callSearchMcp(EXA_MCP_URL, "web_search_exa", {
    query,
    type: "auto",
    numResults: maxResults,
    livecrawl: "fallback",
  });
  if (exa) {
    return { answer: exa, provider: "exa" };
  }
  logger.warn({ src: "webSearchService:keyless" }, "Keyless search failed on both providers");
  throw new Error("Keyless web search failed: Parallel and Exa both returned no result");
}
