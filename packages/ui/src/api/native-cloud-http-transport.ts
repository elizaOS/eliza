import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { type AgentRequestTransport, fetchAgentTransport } from "./transport";

const DIRECT_CLOUD_API_HOSTS = new Set(["api.elizacloud.ai"]);
const CLOUD_HOST_SUFFIX = ".elizacloud.ai";

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
 * Any managed cloud HTTPS endpoint on a native build — the central
 * `api.elizacloud.ai` host or a dedicated agent subdomain
 * (`<agentId>.elizacloud.ai`). Used to decide whether the SSE-streaming bypass
 * applies; non-streaming requests still route exactly as before.
 */
function isNativeCloudHttpsUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  if (!Capacitor.isNativePlatform()) return false;
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return host === "api.elizacloud.ai" || host.endsWith(CLOUD_HOST_SUFFIX);
}

/**
 * An SSE / streaming request — the chat reply's token stream. Detected by the
 * `Accept: text/event-stream` header or a `…/stream` path. `CapacitorHttp`
 * buffers the entire response before resolving, which collapses token streaming
 * into a single blob delivered only after the full server-side generation. The
 * native browser fetch (`CapacitorWebFetch`) streams `response.body`
 * incrementally instead.
 */
function isStreamingRequest(
  url: string,
  headers: HeadersInit | undefined,
): boolean {
  const accept = new Headers(headers ?? {}).get("accept") ?? "";
  if (accept.toLowerCase().includes("text/event-stream")) return true;
  const parsed = parseUrl(url);
  return parsed ? parsed.pathname.endsWith("/stream") : url.includes("/stream");
}

type NativeWebFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

/**
 * The original, un-patched browser `fetch` that Capacitor preserves as
 * `CapacitorWebFetch` when its HTTP plugin patches the global `fetch`. Using it
 * bypasses `CapacitorHttp` so SSE responses stream token-by-token. The managed
 * cloud agent serves CORS for the app origin, so the WebView fetch is allowed
 * cross-origin.
 */
function nativeWebFetch(): NativeWebFetch | null {
  const candidate = (globalThis as { CapacitorWebFetch?: unknown })
    .CapacitorWebFetch;
  return typeof candidate === "function" ? (candidate as NativeWebFetch) : null;
}

function headersToRecord(
  headers: HeadersInit | undefined,
): Record<string, string> {
  if (!headers) return {};
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function methodAllowsBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}

function bodyToNativeData(body: BodyInit | null | undefined): unknown {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return undefined;
}

function responseBody(data: unknown): string {
  if (data === null || data === undefined) return "";
  if (typeof data === "string") return data;
  return JSON.stringify(data);
}

const nativeCloudHttpTransport: AgentRequestTransport = {
  async request(url, init, context) {
    // SSE chat streams must bypass CapacitorHttp (which buffers the whole
    // response) and use the native browser fetch so `response.body` streams
    // incrementally — first token in ~2s instead of the full reply landing as
    // one blob after generation finishes. Covers both `api.elizacloud.ai` and
    // dedicated agent subdomains.
    if (isNativeCloudHttpsUrl(url) && isStreamingRequest(url, init.headers)) {
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
    const data = bodyToNativeData(init.body);
    if (init.body != null && data === undefined) {
      return fetchAgentTransport.request(url, init, context);
    }

    const result = await CapacitorHttp.request({
      url,
      method,
      headers: headersToRecord(init.headers),
      ...(methodAllowsBody(method) && data !== undefined ? { data } : {}),
      responseType: "text",
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
  // Claim direct cloud API calls (CapacitorHttp path) and any native cloud
  // HTTPS URL (so an SSE stream to an agent subdomain can take the
  // CapacitorWebFetch path). Non-streaming agent-subdomain calls fall through
  // to the patched global fetch inside `request`, preserving prior behavior.
  if (isNativeDirectCloudApiUrl(url)) return nativeCloudHttpTransport;
  if (isNativeCloudHttpsUrl(url)) return nativeCloudHttpTransport;
  return null;
}
