/**
 * AgentRequestTransport for the desktop-hosted local agent: dispatches requests
 * over the Electrobun renderer RPC to the in-process agent via its IPC base.
 */
import {
  isMobileLocalAgentIpcUrl,
  mobileLocalAgentPathFromUrl,
} from "../first-run/mobile-runtime-mode";
import { getElectrobunRendererRpc } from "../bridge/electrobun-rpc";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
import {
  type AgentRequestTransport,
  bodyToString,
  headersToRecord,
  methodAllowsBody,
} from "./transport";

/**
 * Desktop (Electrobun) local-agent transport (#12180).
 *
 * When the desktop app runs the on-device agent over native IPC, the renderer's
 * API base is the `eliza-local-agent://ipc` scheme (the same identity the mobile
 * platforms already use) rather than `http://127.0.0.1:<port>`. Requests to that
 * base must not open a socket — they route through the Electrobun main process
 * over `window.__ELIZA_ELECTROBUN_RPC__.request.localAgentRequest(...)`, which
 * drives the in-process route kernel (stdio bridge) with no TCP listener.
 *
 * This resolver is DORMANT until a future PR (#12180 item 4) adds the
 * `localAgentRequest` RPC handler in the Electrobun main process AND switches the
 * desktop API base to the IPC scheme in local mode. Until then no code path sets
 * the base to `eliza-local-agent://ipc`, so `desktopLocalAgentTransportForUrl`
 * always returns `null` and the transport is never exercised. If the base is
 * flipped before the handler exists, `request` throws a clear
 * not-yet-implemented error rather than silently falling back to HTTP.
 */

interface DesktopLocalAgentRequestResult {
  status: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string | null;
}

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
    const rpc = getElectrobunRendererRpc();
    const request = rpc?.request?.localAgentRequest;
    if (!request || !rpc?.request) {
      // The IPC base is active but the main-process handler is not wired yet.
      // Fail loudly — falling back to fetch would open a socket the whole
      // feature exists to remove.
      throw new Error(
        "Desktop local-agent IPC transport is not available: window.__ELIZA_ELECTROBUN_RPC__.request.localAgentRequest is not registered (#12180 item 4 not yet landed)",
      );
    }

    const method = init.method ?? "GET";
    const body = bodyToString(init.body);
    const result = (await request.call(rpc.request, {
      // The path relative to the IPC base; the main process joins it to the
      // in-process route kernel. Fall back to the raw url if it is not an IPC
      // URL (should not happen — the resolver gates on isElectrobunLocalMode).
      path: mobileLocalAgentPathFromUrl(url) ?? url,
      method,
      headers: headersToRecord(init.headers),
      body: methodAllowsBody(method) ? (body ?? null) : null,
      timeoutMs: context?.timeoutMs,
    })) as DesktopLocalAgentRequestResult;

    return new Response(result.body ?? "", {
      status: result.status,
      statusText: result.statusText ?? "",
      headers: result.headers,
    });
  },
};

export function desktopLocalAgentTransportForUrl(
  url: string,
): Promise<AgentRequestTransport | null> {
  return Promise.resolve(
    isElectrobunLocalMode(url) ? desktopLocalAgentTransport : null,
  );
}
