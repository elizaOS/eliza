/**
 * AgentRequestTransport for the desktop shell: routes HTTP through the Electrobun
 * renderer RPC (bypassing CORS/bind-host limits) when running under Electrobun,
 * falling back to fetch otherwise.
 */

import { isLoopbackBindHost, isWildcardBindHost } from "@elizaos/core/protocol";
import {
  isElizaCloudControlPlaneHostname,
  isElizaDedicatedAgentHostname,
} from "@elizaos/plugin-elizacloud/cloud-config/domain-contract";
import {
  type AgentRequestTransport,
  awaitBridgeRequest,
  bodyToString,
  fetchAgentTransport,
  getElectrobunRendererRpc,
  headersToRecord,
  isDesktopExternalHttpApiBaseUrl,
  isElectrobunRuntime,
  methodAllowsBody,
  nativeHttpResultToResponse,
} from "@elizaos/ui";

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
    init.signal?.throwIfAborted();
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
    const result = await awaitBridgeRequest(
      async () =>
        (await request.call(rpc.request, {
          url,
          method,
          headers: headersToRecord(init.headers),
          body: methodAllowsBody(method) ? (body ?? null) : null,
          timeoutMs: context?.timeoutMs,
        })) as DesktopHttpRequestResult,
      init.signal,
      context?.timeoutMs,
    );
    return nativeHttpResultToResponse(result);
  },
};
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
