/**
 * Cross-window relay for the shell chat/voice controller (#16442). Each desktop
 * webview is an isolated renderer, so the only path between them is this native
 * main process: a renderer publishes a shell-sync envelope via the
 * `shellControllerRelay` RPC request, and this module rebroadcasts it to every
 * OTHER open window as a `shellControllerSync` push message. That is what lets a
 * single elected owner window run the one engine while followers render its
 * state — the renderer-side coordinator (`@elizaos/ui`) owns all the semantics;
 * this is a dumb, opaque pipe.
 *
 * Endpoints register at `createDesktopRpc` time (the one place every window's
 * `sendToWebview` is built) and release when the window tears down. The relay
 * broadcasts to EVERY window, including the publisher: the renderer coordinator
 * filters its own messages by window id / role / target, so a self-echo is a
 * no-op there. That keeps the native side a trivial fan-out with no per-window
 * identity to thread through.
 */
import type { SendToWebview } from "./types";

/** The push-message name followers subscribe to; mirrors the renderer constant
 *  `SHELL_SYNC_PUSH_MESSAGE` in `@elizaos/ui`. */
export const SHELL_SYNC_PUSH_MESSAGE = "shellControllerSync";

const endpoints = new Map<string, SendToWebview>();
let endpointCounter = 0;

/**
 * Register a window's renderer as a relay endpoint. Returns a `release` to call
 * when the window closes so a churned detached surface does not leak.
 */
export function registerShellSyncEndpoint(send: SendToWebview): {
  release: () => void;
} {
  endpointCounter += 1;
  const id = `endpoint-${endpointCounter}`;
  endpoints.set(id, send);
  return {
    release: () => {
      endpoints.delete(id);
    },
  };
}

/**
 * Rebroadcast an envelope to every registered window. Opaque: the envelope is
 * forwarded as-is (validated on the renderer side at the IPC boundary). Returns
 * how many windows it was delivered to, for diagnostics.
 */
export function broadcastShellSyncEnvelope(envelope: unknown): number {
  let delivered = 0;
  for (const send of endpoints.values()) {
    send(SHELL_SYNC_PUSH_MESSAGE, { envelope });
    delivered += 1;
  }
  return delivered;
}

/** Test-only: the live endpoint count. */
export function shellSyncEndpointCount(): number {
  return endpoints.size;
}
