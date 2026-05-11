import { assertSafeOutboundUrl } from "@/lib/security/outbound-url";

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
): Promise<Response> {
  const target = await assertSafeOutboundUrl(upstreamUrl);
  const init: RequestInit = {
    method: request.method,
    headers: forwardOutgoingHeaders(request.headers),
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD" && request.body != null) {
    init.body = request.body;
  }
  try {
    init.signal = AbortSignal.timeout(MCP_UPSTREAM_TIMEOUT_MS);
    return await fetch(target.toString(), init);
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
