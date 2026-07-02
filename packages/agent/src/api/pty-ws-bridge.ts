/**
 * WebSocket-side PTY session plumbing for the agent server.
 *
 * Two responsibilities, both extracted from the `/ws` connection handler in
 * `server.ts` so they are unit-testable without booting the HTTP server:
 *
 * 1. {@link attachPtySessionWsBridge} — subscribes one WS client to a PTY
 *    session on the console bridge, forwarding `session_output` as
 *    `pty-output` frames AND `session_exit` as a `pty-exit` frame. Before
 *    this, only `session_output` was bridged, so a dead session looked
 *    "ready forever" to the dashboard terminal.
 *
 * 2. {@link schedulePtySessionStopAfterGrace} — delays the "client
 *    disconnected → kill its PTY sessions" reap by a grace window, cancelable
 *    when the same clientId reconnects. Before this, ANY WS close/error
 *    (phone lock, app switch, network blip) killed the interactive session
 *    instantly.
 */

import type { ConsoleBridge } from "./parse-action-block.ts";

/**
 * Max UTF-16 length of a single `pty-input` WS message the server accepts.
 * This is a DoS cap, not a paste-size cap: the client splits larger input
 * into ordered chunks of at most this size (see `sendPtyInput` in
 * `packages/ui/src/api/client-agent.ts`, which mirrors this value).
 */
export const MAX_PTY_INPUT_MESSAGE_LENGTH = 4096;

/** Grace window before a disconnected client's PTY sessions are stopped. */
export const DEFAULT_PTY_DISCONNECT_GRACE_MS = 30_000;

/**
 * Parses `ELIZA_PTY_WS_DISCONNECT_GRACE_MS`-style overrides. Empty/absent or
 * unparseable/negative values fall back to the default; `0` is honored as
 * "no grace" (legacy stop-on-close behavior).
 */
export function resolvePtyDisconnectGraceMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PTY_DISCONNECT_GRACE_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_PTY_DISCONNECT_GRACE_MS;
  }
  return parsed;
}

/** Frame shapes the bridge forwards to the WS client. */
export type PtyWsFrame =
  | { type: "pty-output"; sessionId: string; data: string }
  | { type: "pty-exit"; sessionId: string; exitCode: number | null };

/** The two bridge events this module consumes. */
type PtyBridgeEvents = Pick<ConsoleBridge, "on" | "off">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Attach one WS client's listeners for `sessionId` on the PTY console bridge.
 * `session_output` → `{type:"pty-output"}` and `session_exit` →
 * `{type:"pty-exit", exitCode}`. Returns a detach function that removes BOTH
 * listeners (stored as the per-session unsubscribe in the server's
 * subscription map).
 */
export function attachPtySessionWsBridge(opts: {
  bridge: PtyBridgeEvents;
  sessionId: string;
  /** Caller guards socket readiness (ws.readyState === OPEN) before sending. */
  send: (frame: PtyWsFrame) => void;
}): () => void {
  const { bridge, sessionId, send } = opts;

  const outputListener = (...args: unknown[]): void => {
    const evt = args[0];
    if (!isRecord(evt) || evt.sessionId !== sessionId) return;
    if (typeof evt.data !== "string") return;
    send({ type: "pty-output", sessionId, data: evt.data });
  };

  const exitListener = (...args: unknown[]): void => {
    const evt = args[0];
    if (!isRecord(evt) || evt.sessionId !== sessionId) return;
    send({
      type: "pty-exit",
      sessionId,
      exitCode: typeof evt.exitCode === "number" ? evt.exitCode : null,
    });
  };

  bridge.on("session_output", outputListener);
  bridge.on("session_exit", exitListener);
  return () => {
    bridge.off("session_output", outputListener);
    bridge.off("session_exit", exitListener);
  };
}

/**
 * Schedule stopping a disconnected client's PTY sessions after `graceMs`.
 *
 * - Skipped entirely when the client still has another live connection.
 * - Re-checked at fire time, so a reconnect during the window survives even
 *   if the cancel path raced.
 * - Re-scheduling for the same clientId replaces the previous timer.
 * - The timer is unref'd so a pending reap never holds the process open.
 */
export function schedulePtySessionStopAfterGrace(opts: {
  clientId: string;
  graceMs: number;
  pendingStops: Map<string, ReturnType<typeof setTimeout>>;
  clientHasLiveConnection: () => boolean;
  stopOwnedSessions: () => void;
}): void {
  const {
    clientId,
    graceMs,
    pendingStops,
    clientHasLiveConnection,
    stopOwnedSessions,
  } = opts;
  if (clientHasLiveConnection()) return;
  const existing = pendingStops.get(clientId);
  if (existing !== undefined) clearTimeout(existing);
  const timer = setTimeout(() => {
    pendingStops.delete(clientId);
    if (clientHasLiveConnection()) return;
    stopOwnedSessions();
  }, graceMs);
  timer.unref?.();
  pendingStops.set(clientId, timer);
}

/**
 * Cancel a pending grace-window stop for `clientId` (called when the same
 * clientId re-authenticates a new WS connection). Returns true when a pending
 * stop was actually canceled — i.e. the client reconnected within the window.
 */
export function cancelPendingPtySessionStop(
  clientId: string,
  pendingStops: Map<string, ReturnType<typeof setTimeout>>,
): boolean {
  const timer = pendingStops.get(clientId);
  if (timer === undefined) return false;
  clearTimeout(timer);
  pendingStops.delete(clientId);
  return true;
}
