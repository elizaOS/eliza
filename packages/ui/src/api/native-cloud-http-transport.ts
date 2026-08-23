/**
 * Native HTTP transport for Eliza Cloud and explicitly selected remote agents.
 * Bounded JSON/binary calls use CapacitorHttp while agent SSE keeps the browser
 * streaming body; arbitrary public origins remain outside this transport.
 */
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import {
  isElizaCloudControlPlaneHostname,
  isElizaDedicatedAgentHostname,
} from "@elizaos/shared/elizacloud";
import { isTrustedRestoreApiBaseUrl } from "../state/runtime-url-trust";
import {
  type AgentRequestTransport,
  bodyToString,
  fetchAgentTransport,
  headersToRecord,
  isStreamingRequest,
  methodAllowsBody,
} from "./transport";

const DIRECT_CLOUD_API_HOSTS = new Set([
  "api.eliza.app",
  "api-staging.eliza.app",
]);

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    // error-policy:J3 explicit invalid signal — null never matches a cloud
    // host, so unparseable URLs stay off the direct-cloud path.
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
 * A dedicated agent subdomain (`<agentId>.cloud.eliza.app`) on a native build —
 * NOT the central `api.eliza.app` host. Only these serve CORS for the app
 * origin (verified: `access-control-allow-origin: <webview origin>` +
 * `X-ElizaOS-Client-Id` in allow-headers), so the native browser fetch can read
 * an SSE stream cross-origin. The central `api.eliza.app` does NOT allow the
 * app origin (it relies on CapacitorHttp's CORS bypass), so its SSE — e.g.
 * `computer-use/approvals/stream` — must stay on CapacitorHttp.
 */
function isNativeCloudAgentSubdomain(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed) return false;
  if (!Capacitor.isNativePlatform()) return false;
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return isElizaDedicatedAgentHostname(host);
}

function isNativeCloudHttpsUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || !Capacitor.isNativePlatform()) return false;
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return (
    isElizaCloudControlPlaneHostname(host) ||
    isElizaDedicatedAgentHostname(host)
  );
}

/**
 * A user-selected remote-Mac endpoint is allowed to bypass WKWebView CORS only
 * after the canonical runtime-mode and private-network trust gates agree. The
 * full request URL may carry an API path, so validate its origin rather than
 * rejecting a legitimate path/query as if it were a persisted base URL.
 */
function isNativeTrustedRemoteAgentUrl(url: string): boolean {
  const parsed = parseUrl(url);
  if (!parsed || !Capacitor.isNativePlatform()) return false;
  try {
    if (
      globalThis.localStorage?.getItem("eliza:mobile-runtime-mode") !==
      "remote-mac"
    ) {
      return false;
    }
  } catch {
    // error-policy:J3 unreadable runtime selection cannot authorize a native
    // CORS bypass; the request stays on the ordinary browser transport.
    return false;
  }
  if (parsed.username || parsed.password) return false;
  return isTrustedRestoreApiBaseUrl(parsed.origin);
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

/** CapacitorHttp expects JSON as a structured bridge value, not serialized text. */
function nativeRequestData(
  body: BodyInit | null | undefined,
  headers: HeadersInit | undefined,
): unknown {
  const serialized = bodyToString(body) ?? undefined;
  if (serialized === undefined) return undefined;

  const contentType = new Headers(headers ?? {})
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json" && !contentType?.endsWith("+json")) {
    return serialized;
  }

  try {
    return JSON.parse(serialized);
  } catch {
    // error-policy:J3 Preserve malformed JSON as malformed wire input so the
    // server remains the authority for its normal explicit validation error.
    return serialized;
  }
}

/** CapacitorHttp returns arraybuffer responses as base64 across the native bridge. */
function responseBytes(data: unknown): ArrayBuffer {
  if (typeof data !== "string" || data.length === 0) return new ArrayBuffer(0);
  const binary = globalThis.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer as ArrayBuffer;
}

const nativeCloudHttpTransport: AgentRequestTransport = {
  async request(url, init, context) {
    // SSE chat streams to a dedicated agent subdomain must bypass CapacitorHttp
    // (which buffers the whole response) and use the native browser fetch so
    // `response.body` streams incrementally — first token in ~2s instead of the
    // full reply landing as one blob after generation finishes. Scoped to agent
    // subdomains only: they serve CORS for the app origin. The central
    // `api.eliza.app` does not, so its SSE stays on CapacitorHttp below.
    const isRemoteAgent = isNativeTrustedRemoteAgentUrl(url);
    if (
      (isNativeCloudAgentSubdomain(url) || isRemoteAgent) &&
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
    const wantsBinary = context?.responseType === "arraybuffer";
    const isDirectApi = isNativeDirectCloudApiUrl(url);
    const isCloudHost = isNativeCloudHttpsUrl(url);
    if (!isDirectApi && !isRemoteAgent && !(wantsBinary && isCloudHost)) {
      return fetchAgentTransport.request(url, init, context);
    }

    const method = init.method ?? "GET";
    // CapacitorHttp crosses a JSON bridge: send JSON as a structured value so
    // iOS serializes the request object once instead of quoting the JSON text.
    const data = nativeRequestData(init.body, init.headers);
    if (init.body != null && data === undefined) {
      return fetchAgentTransport.request(url, init, context);
    }

    const result = await CapacitorHttp.request({
      url,
      method,
      headers: headersToRecord(init.headers),
      ...(methodAllowsBody(method) && data !== undefined ? { data } : {}),
      responseType: wantsBinary ? "arraybuffer" : "text",
      // Don't auto-follow 3xx: this path forwards the user's cloud bearer to
      // the dedicated agent subdomain, and CapacitorHttp (unlike browser fetch)
      // would replay the Authorization header across a redirect. A 3xx here is a
      // misconfig/open-redirect signal — surface it instead of leaking the token
      // off the managed Eliza hosts. (The router/API must never 30x a
      // bearer-carrying request.)
      disableRedirects: true,
      ...(context?.timeoutMs
        ? {
            connectTimeout: context.timeoutMs,
            readTimeout: context.timeoutMs,
          }
        : {}),
    });

    // CapacitorHttp ignores the requested `arraybuffer` responseType for
    // `application/json` responses and delivers a parsed object instead of
    // base64. That happens exactly on the failure path (e.g. a 400/401/403
    // JSON error from /api/v1/voice/tts), so routing it through
    // `responseBytes()` would blank the body and hide the error text from
    // callers. Only decode base64 for successful binary payloads; keep the
    // text/JSON body path for errors and non-string data so `res.text()`
    // still surfaces the server's message.
    const useBinaryBody =
      wantsBinary &&
      result.status >= 200 &&
      result.status < 300 &&
      typeof result.data === "string";
    return new Response(
      useBinaryBody ? responseBytes(result.data) : responseBody(result.data),
      {
        status: result.status,
        headers: result.headers,
      },
    );
  },
};

export function nativeCloudHttpTransportForUrl(
  url: string,
): AgentRequestTransport | null {
  // Claim Eliza Cloud HTTPS hosts so binary requests can use CapacitorHttp.
  // Text requests preserve the existing host policy inside `request`: direct API
  // calls use CapacitorHttp, dedicated-agent SSE can use CapacitorWebFetch, and
  // all other requests fall through to the patched global fetch.
  if (isNativeDirectCloudApiUrl(url)) return nativeCloudHttpTransport;
  if (isNativeCloudHttpsUrl(url)) return nativeCloudHttpTransport;
  if (isNativeTrustedRemoteAgentUrl(url)) return nativeCloudHttpTransport;
  return null;
}
