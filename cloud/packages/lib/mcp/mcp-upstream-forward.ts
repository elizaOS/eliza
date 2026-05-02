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
  return fetch(target.toString(), init);
}
