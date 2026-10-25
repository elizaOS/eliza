/**
 * AgentRequestTransport for the desktop-hosted local agent: dispatches requests
 * over the Electrobun renderer RPC to the in-process agent via its IPC base.
 */

import {
  type AgentRequestTransport,
  awaitBridgeRequest,
  getElectrobunRendererRpc,
  headersToRecord,
  isElectrobunRuntime,
  isMobileLocalAgentIpcUrl,
  methodAllowsBody,
  mobileLocalAgentPathFromUrl,
  type NativeHttpResult,
  nativeHttpResultToResponse,
  requireTextRequestBody,
} from "@elizaos/ui";

/**
 * True when `url` targets the desktop local-agent IPC base under an Electrobun
 * runtime. Mirrors `isMobileLocalAgentIpcUrl` (same `eliza-local-agent://ipc`
 * scheme), gated to Electrobun so mobile IPC URLs never resolve here.
 */
export function isElectrobunLocalMode(url: string): boolean {
  return isElectrobunRuntime() && isMobileLocalAgentIpcUrl(url);
}

const desktopLocalAgentTransport: AgentRequestTransport = {
  async request(url, init, context) {
    init.signal?.throwIfAborted();
    const rpc = getElectrobunRendererRpc();
    const request = rpc?.request?.localAgentRequest;
    if (!request || !rpc?.request) {
      // The IPC base is active but the main-process handler is not wired yet.
      // Fail loudly — falling back to fetch would open a socket the whole
      // feature exists to remove.
      throw new Error(
        "Desktop local-agent IPC transport is not available: window.__ELIZA_ELECTROBUN_RPC__.request.localAgentRequest is not registered",
      );
    }

    const method = (init.method ?? "GET").toUpperCase();
    const body = requireTextRequestBody(init.body);
    if (!methodAllowsBody(method) && body != null) {
      throw new TypeError(`${method} requests must not carry a body.`);
    }
    const result = await awaitBridgeRequest(
      async () =>
        (await request.call(rpc.request, {
          // The path relative to the IPC base; the main process joins it to the
          // in-process route kernel. Fall back to the raw url if it is not an IPC
          // URL (should not happen — the resolver gates on isElectrobunLocalMode).
          path: mobileLocalAgentPathFromUrl(url) ?? url,
          method,
          headers: headersToRecord(init.headers),
          body: methodAllowsBody(method) ? (body ?? null) : null,
          timeoutMs: context?.timeoutMs,
        })) as NativeHttpResult,
      init.signal,
      context?.timeoutMs,
    );

    return nativeHttpResultToResponse(result);
  },
};

export function desktopLocalAgentTransportForUrl(
  url: string,
): Promise<AgentRequestTransport | null> {
  return Promise.resolve(
    isElectrobunLocalMode(url) ? desktopLocalAgentTransport : null,
  );
}
