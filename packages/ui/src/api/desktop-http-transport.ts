/**
 * AgentRequestTransport for the desktop shell: routes HTTP through the Electrobun
 * renderer RPC (bypassing CORS/bind-host limits) when running under Electrobun,
 * falling back to fetch otherwise.
 */
import { isLoopbackBindHost, isWildcardBindHost } from "@elizaos/shared";
import { getElectrobunRendererRpc } from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import { isDesktopExternalHttpApiBaseUrl } from "./desktop-external-api-base";
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
    (isExternalPlainHttpUrl(url) || isDesktopExternalHttpApiBaseUrl(url))
    ? desktopHttpTransport
    : null;
}
