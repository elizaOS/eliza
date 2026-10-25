/** Proxies bounded MCP transport requests to operator-configured upstream services. */
import { safeFetch } from "../security/safe-fetch";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);
const MCP_UPSTREAM_TIMEOUT_MS = 8_000;

export interface McpUpstreamForwardOptions {
  readonly timeoutMs?: number;
}

function resolveTimeoutMs(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : MCP_UPSTREAM_TIMEOUT_MS;
}

function forwardOutgoingHeaders(source: Headers): Headers {
  const out = new Headers();
  for (const [name, value] of source.entries()) {
    const lower = name.toLowerCase();
    if (lower === "host" || HOP_BY_HOP.has(lower)) continue;
    out.append(name, value);
  }
  return out;
}

/**
 * Proxy an MCP streamable-http request to an operator-configured absolute URL.
 */
export async function forwardMcpUpstreamRequest(
  request: Request,
  upstreamUrl: string,
  options: McpUpstreamForwardOptions = {},
): Promise<Response> {
  const init: RequestInit = {
    method: request.method,
    headers: forwardOutgoingHeaders(request.headers),
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body != null) {
    init.body = request.body;
  }
  try {
    init.signal = AbortSignal.timeout(resolveTimeoutMs(options.timeoutMs));
    return await safeFetch(upstreamUrl, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json(
      {
        success: false,
        error: "mcp_upstream_unavailable",
        message,
      },
      { status: 503 },
    );
  }
}
