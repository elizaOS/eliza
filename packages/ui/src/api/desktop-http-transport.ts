/**
 * AgentRequestTransport for the desktop shell: routes HTTP through the Electrobun
 * renderer RPC (bypassing CORS/bind-host limits) when running under Electrobun,
 * falling back to fetch otherwise.
 */
import {
  isElizaCloudControlPlaneHostname,
  isElizaDedicatedAgentHostname,
  isLoopbackBindHost,
  isWildcardBindHost,
} from "@elizaos/shared";
import { getElectrobunRendererRpc } from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import { isDesktopExternalHttpApiBaseUrl } from "./desktop-external-api-base";
import {
  type AgentRequestTransport,
  bodyToBase64,
  bodyToString,
  fetchAgentTransport,
  headersToRecord,
  methodAllowsBody,
} from "./transport";

interface DesktopHttpRequestResult {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | null;
  bodyBase64?: string | null;
}

function isExternalPlainHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "http:" &&
      !isLoopbackBindHost(parsed.hostname) &&
      !isWildcardBindHost(parsed.hostname)
    );
  } catch {
    // error-policy:J3 unparseable URL is not routed through the privileged
    // desktop HTTP bridge (fail-closed).
    return false;
  }
}

/**
 * Trusted Eliza Cloud HTTPS origins whose CORS policy does not allowlist
 * loopback renderer origins. The desktop main process proxies these through
 * desktopHttpRequest to bypass the WKWebView CORS block.
 */
function isTrustedElizaCloudHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return false;
    const hostname = parsed.hostname.toLowerCase();
    return (
      isElizaCloudControlPlaneHostname(hostname) ||
      isElizaDedicatedAgentHostname(hostname)
    );
  } catch {
    return false;
  }
}

const desktopHttpTransport: AgentRequestTransport = {
  async request(url, init, context) {
    const rpc = getElectrobunRendererRpc();
    const request = rpc?.request?.desktopHttpRequest;
    if (!request || !rpc?.request) {
      return fetchAgentTransport.request(url, init, context);
    }

    const method = init.method ?? "GET";
    const rawBody = init.body;
    const body = bodyToString(rawBody);

    // String body — send directly through the RPC bridge.
    if (body !== undefined || rawBody === null || rawBody === undefined) {
      if (
        (body === undefined && rawBody != null) ||
        (!methodAllowsBody(method) && body != null)
      ) {
        return fetchAgentTransport.request(url, init, context);
      }

      const result = (await request.call(rpc.request, {
        url,
        method,
        headers: headersToRecord(init.headers),
        body: methodAllowsBody(method) ? (body ?? null) : null,
        timeoutMs: context?.timeoutMs,
      })) as DesktopHttpRequestResult;

      return decodeDesktopHttpResponse(result);
    }

    // Binary body (FormData, ArrayBuffer, Blob, Uint8Array) — serialize as
    // base64 so the Electrobun RPC string bridge can carry it without
    // corruption. The main process decodes base64 back to bytes and sets the
    // correct Content-Type (including multipart boundary for FormData).
    if (!methodAllowsBody(method)) {
      return fetchAgentTransport.request(url, init, context);
    }

    const binaryBody = await bodyToBase64(rawBody);
    if (!binaryBody) {
      // Unrecognized body type — fall back to fetch.
      return fetchAgentTransport.request(url, init, context);
    }

    // Merge the binary Content-Type into the headers, replacing any
    // caller-supplied Content-Type (the boundary from FormData serialization
    // is authoritative for multipart bodies).
    const headers = headersToRecord(init.headers);
    headers["content-type"] = binaryBody.contentType;

    const result = (await request.call(rpc.request, {
      url,
      method,
      headers,
      body: null,
      bodyBase64: binaryBody.bodyBase64,
      timeoutMs: context?.timeoutMs,
    })) as DesktopHttpRequestResult;

    return decodeDesktopHttpResponse(result);
  },
};

function decodeDesktopHttpResponse(
  result: DesktopHttpRequestResult,
): Response {
  // Binary responses (audio, image, etc.) arrive as base64 to avoid UTF-8
  // corruption through the Electrobun RPC string bridge.
  if (result.bodyBase64) {
    const binary = atob(result.bodyBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Response(bytes, {
      status: result.status,
      statusText: result.statusText ?? "",
      headers: result.headers,
    });
  }

  return new Response(result.body ?? "", {
    status: result.status,
    statusText: result.statusText ?? "",
    headers: result.headers,
  });
}

export function desktopHttpTransportForUrl(
  url: string,
): AgentRequestTransport | null {
  return isElectrobunRuntime() &&
    (isExternalPlainHttpUrl(url) ||
      isDesktopExternalHttpApiBaseUrl(url) ||
      isTrustedElizaCloudHttpsUrl(url))
    ? desktopHttpTransport
    : null;
}
