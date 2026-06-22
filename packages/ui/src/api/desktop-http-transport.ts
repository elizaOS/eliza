import { isLoopbackBindHost, isWildcardBindHost } from "@elizaos/shared";
import { getElectrobunRendererRpc } from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import {
  type AgentRequestTransport,
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
    return false;
  }
}

function getConfiguredExternalApiBaseOrigin(): string | null {
  if (typeof window === "undefined") return null;
  const value = (window as { __ELIZA_DESKTOP_EXTERNAL_API_BASE__?: unknown })
    .__ELIZA_DESKTOP_EXTERNAL_API_BASE__;
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function isConfiguredExternalApiBaseUrl(url: string): boolean {
  const allowedOrigin = getConfiguredExternalApiBaseOrigin();
  if (!allowedOrigin) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && parsed.origin === allowedOrigin;
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

    return new Response(result.body ?? "", {
      status: result.status,
      statusText: result.statusText ?? "",
      headers: result.headers,
    });
  },
};

export function desktopHttpTransportForUrl(
  url: string,
): AgentRequestTransport | null {
  return isElectrobunRuntime() &&
    (isExternalPlainHttpUrl(url) || isConfiguredExternalApiBaseUrl(url))
    ? desktopHttpTransport
    : null;
}
