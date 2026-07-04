/**
 * AgentRequestTransport for native (Capacitor) builds talking to Eliza Cloud:
 * uses CapacitorHttp for direct cloud hosts (bypassing the WKWebView CORS/cookie
 * limits), falling back to fetch for everything else.
 */
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import {
  type AgentRequestTransport,
  bodyToString,
  fetchAgentTransport,
  headersToRecord,
  isStreamingRequest,
  methodAllowsBody,
} from "./transport";

const DIRECT_CLOUD_API_HOSTS = new Set(["api.elizacloud.ai"]);
const CLOUD_HOST_SUFFIX = ".elizacloud.ai";
// Hosts under *.elizacloud.ai that are NOT dedicated agent subdomains: the
// central API plus the web/auth hosts and the apex. None of these serve CORS
// for the app origin, so their SSE must stay on CapacitorHttp's bypass path —
// only `<agentId>.elizacloud.ai` subdomains route through native fetch.
const NON_AGENT_CLOUD_HOSTS = new Set([
  "api.elizacloud.ai",
  "www.elizacloud.ai",
  "dev.elizacloud.ai",
  "elizacloud.ai",
]);

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isNativeDirectCloudApiUrl(url: string): boolean {
  const parsed = parseUrl(url);
  return (
    parsed !== null &&
    Capacitor.isNativePlatform() &&
    parsed.protocol === "https:" &&
    DIRECT_CLOUD_API_HOSTS.has(parsed.hostname.toLowerCase())
  );
}

/**
 * A dedicated agent subdomain (`<agentId>.elizacloud.ai`) on a native build —
 * NOT the central `api.elizacloud.ai` host. Only these serve CORS for the app
 * origin (verified: `access-control-allow-origin: <webview origin>` +
 * `X-ElizaOS-Client-Id` in allow-headers), so the native browser fetch can read
 * an SSE stream cross-origin. The central `api.elizacloud.ai` does NOT allow the
 * app origin (it relies on CapacitorHttp's CORS bypass), so its SSE — e.g.
 * `computer-use/approvals/stream` — must stay on CapacitorHttp.
 */
function isNativeCloudAgentSubdomain(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  if (!Capacitor.isNativePlatform()) return false;
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return !NON_AGENT_CLOUD_HOSTS.has(host) && host.endsWith(CLOUD_HOST_SUFFIX);
}

type NativeWebFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The original, un-patched browser `fetch` that Capacitor preserves as
 * `CapacitorWebFetch` when its HTTP plugin patches the global `fetch`. Using it
 * bypasses `CapacitorHttp` so SSE responses stream token-by-token. Only used for
 * dedicated agent subdomains, which serve CORS for the app origin.
 */
function nativeWebFetch(): NativeWebFetch | null {
  const candidate = (globalThis as { CapacitorWebFetch?: unknown })
    .CapacitorWebFetch;
  return typeof candidate === "function" ? (candidate as NativeWebFetch) : null;
}

function responseBody(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  return JSON.stringify(data);
}

const nativeCloudHttpTransport: AgentRequestTransport = {
  async request(url, init, context) {
    // SSE chat streams to a dedicated agent subdomain must bypass CapacitorHttp
    // (which buffers the whole response) and use the native browser fetch so
    // `response.body` streams incrementally — first token in ~2s instead of the
    // full reply landing as one blob after generation finishes. Scoped to agent
    // subdomains only: they serve CORS for the app origin. The central
    // `api.elizacloud.ai` does not, so its SSE stays on CapacitorHttp below.
    if (
      isNativeCloudAgentSubdomain(url) &&
      isStreamingRequest(url, init.headers)
    ) {
      const webFetch = nativeWebFetch();
      if (webFetch) {
        return webFetch(url, init);
      }
    }

    // Non-streaming requests to a dedicated agent subdomain (or any non-direct
    // cloud URL) keep their existing path — the patched global fetch — so this
    // change only affects the SSE streaming case above.
    if (!isNativeDirectCloudApiUrl(url)) {
      return fetchAgentTransport.request(url, init, context);
    }

    const method = init.method ?? "GET";
    // CapacitorHttp has no concept of a null body — treat null and undefined alike.
    const data = bodyToString(init.body) ?? undefined;
    if (init.body != null && data === undefined) {
      return fetchAgentTransport.request(url, init, context);
    }

    const result = await CapacitorHttp.request({
      url,
      method,
      headers: headersToRecord(init.headers),
      ...(methodAllowsBody(method) && data !== undefined ? { data } : {}),
      responseType: "text",
      // Don't auto-follow 3xx: this path forwards the user's cloud bearer to
      // the dedicated agent subdomain, and CapacitorHttp (unlike browser fetch)
      // would replay the Authorization header across a redirect. A 3xx here is a
      // misconfig/open-redirect signal — surface it instead of leaking the token
      // off *.elizacloud.ai. (The agent-router/central API must never 30x a
      // bearer-carrying request.)
      disableRedirects: true,
      ...(context?.timeoutMs
        ? {
            connectTimeout: context.timeoutMs,
            readTimeout: context.timeoutMs,
          }
        : {}),
    });

    return new Response(responseBody(result.data), {
      status: result.status,
      headers: result.headers,
    });
  },
};

export function nativeCloudHttpTransportForUrl(
  url: string,
): AgentRequestTransport | null {
  // Claim direct cloud API calls (CapacitorHttp path) and dedicated agent
  // subdomains (so an SSE stream there can take the CapacitorWebFetch path).
  // Non-streaming agent-subdomain calls fall through to the patched global fetch
  // inside `request`, preserving prior behavior.
  if (isNativeDirectCloudApiUrl(url)) return nativeCloudHttpTransport;
  if (isNativeCloudAgentSubdomain(url)) return nativeCloudHttpTransport;
  return null;
}
