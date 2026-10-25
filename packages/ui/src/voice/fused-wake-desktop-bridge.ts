/**
 * Desktop transport for the fused on-device wake path (#10351).
 *
 * The battery-efficient openWakeWord runtime (`libwakeword`) runs in the desktop
 * agent/Bun main process (the `FusedWakeManager` native module), not the
 * renderer. When a real wake fires it pushes a `voice:fusedWake` message over the
 * electrobun runtime→renderer channel carrying the canonical
 * `FusedWakeEventDetail` (`{ stage:'head-fired', confidence }`). This module is
 * the renderer end of that channel: it forwards each message to
 * {@link emitFusedWake}, so the existing {@link useWakeController} subscription
 * activates the bottom bar exactly as a synthetic test would — turning on the
 * battery-efficient path that #10373 wired the consumer + contract for.
 *
 * On non-desktop hosts (no electrobun RPC) registration is a no-op and the
 * Swabble Web-Speech fallback path is left untouched.
 *
 * {@link useWakeController} follows the detector status this module records, so
 * `openWakeWord` turns on when the detector reports it started and off when it
 * stops. Call {@link registerDesktopFusedWake} at renderer boot.
 */

import {
  getElectrobunRendererRpc,
  invokeDesktopBridgeRequest,
  subscribeDesktopBridgeEvent,
} from "../bridge/electrobun-rpc";
import { loadWakeWordEnabled } from "../state/persistence";
import {
  emitFusedWake,
  type FusedWakeEvent,
  type FusedWakeStatus,
  getFusedWakeStatus,
  setFusedWakeStatus,
} from "./fused-wake-bridge";

/** The `voice:fusedWake` message name on the electrobun runtime→renderer bus. */
export const DESKTOP_FUSED_WAKE_MESSAGE = "voice:fusedWake";

/**
 * Narrow an untyped bridge payload to a {@link FusedWakeEvent}. The desktop
 * producer only emits the terminal `head-fired` stage (the standalone
 * openWakeWord head is a single trained-head detector); the two-stage variants
 * are accepted structurally for forward-compatibility but never invented here.
 */
function toFusedWakeEvent(payload: unknown): FusedWakeEvent | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as {
    stage?: unknown;
    confidence?: unknown;
    transcript?: unknown;
  };
  if (
    p.stage !== "head-fired" &&
    p.stage !== "stage-a-candidate" &&
    p.stage !== "stage-b-transcript"
  ) {
    return null;
  }
  const event: FusedWakeEvent = { stage: p.stage };
  if (typeof p.confidence === "number") event.confidence = p.confidence;
  if (typeof p.transcript === "string") event.transcript = p.transcript;
  return event;
}

/** The `voice:fusedWakeState` message the main process sends on start/stop. */
export const DESKTOP_FUSED_WAKE_STATE_MESSAGE = "voice:fusedWakeState";

// Start/stop requests run one at a time. The main-process manager is not
// re-entrant: a start issued while another start is still loading the model
// would open a second microphone.
let detectorRequests: Promise<unknown> = Promise.resolve();

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Start the native libwakeword detector in the main process and record what it
 * reported. `{ started: false, reason }` (wake models not staged, microphone
 * refused, ...) leaves the capability off and keeps the reason for Settings.
 * No-op on a host without the electrobun RPC.
 */
export function armDesktopFusedWake(): Promise<FusedWakeStatus> {
  const run = detectorRequests.then(async (): Promise<FusedWakeStatus> => {
    if (!getElectrobunRendererRpc()) return getFusedWakeStatus();
    let status: FusedWakeStatus;
    try {
      const result = await invokeDesktopBridgeRequest<{
        started: boolean;
        reason?: string;
      }>({
        rpcMethod: "fusedWakeStart",
        ipcChannel: "fusedWake:start",
        params: {},
      });
      status = result?.started
        ? { bridged: true, listening: true }
        : {
            bridged: true,
            listening: false,
            reason: result?.reason ?? "fused-wake-rpc-unavailable",
          };
    } catch (err) {
      status = {
        bridged: true,
        listening: false,
        reason: `fused-wake-start-failed: ${describeError(err)}`,
      };
    }
    setFusedWakeStatus(status);
    return status;
  });
  detectorRequests = run;
  return run;
}

/** Stop the native detector and release its microphone. */
export function disarmDesktopFusedWake(): Promise<void> {
  const run = detectorRequests.then(async (): Promise<void> => {
    if (!getElectrobunRendererRpc()) return;
    try {
      await invokeDesktopBridgeRequest({
        rpcMethod: "fusedWakeStop",
        ipcChannel: "fusedWake:stop",
      });
      setFusedWakeStatus({ bridged: true, listening: false });
    } catch (err) {
      setFusedWakeStatus({
        ...getFusedWakeStatus(),
        reason: `fused-wake-stop-failed: ${describeError(err)}`,
      });
    }
  });
  detectorRequests = run;
  return run;
}

/**
 * Wire the desktop fused-wake channel into the renderer and, when the user's
 * wake-word setting is on, arm the native detector. Returns an unsubscribe
 * function (which also stops the detector). On a non-desktop host (no
 * electrobun RPC) it is a no-op that returns a no-op cleanup, so
 * {@link useWakeController} keeps the Swabble fallback.
 *
 * `window.__ELIZA_FUSED_WAKE__` follows the detector, not the host: it is set
 * only after `fusedWakeStart` reports `started: true`, and cleared when the
 * detector stops.
 */
export function registerDesktopFusedWake(): () => void {
  if (!getElectrobunRendererRpc()) return () => {};
  setFusedWakeStatus({ bridged: true, listening: false });
  const unsubscribe = subscribeDesktopBridgeEvent({
    rpcMessage: DESKTOP_FUSED_WAKE_MESSAGE,
    ipcChannel: DESKTOP_FUSED_WAKE_MESSAGE,
    listener: (payload) => {
      const event = toFusedWakeEvent(payload);
      if (event) emitFusedWake(event);
    },
  });
  const unsubscribeState = subscribeDesktopBridgeEvent({
    rpcMessage: DESKTOP_FUSED_WAKE_STATE_MESSAGE,
    ipcChannel: DESKTOP_FUSED_WAKE_STATE_MESSAGE,
    listener: (payload) => {
      const listening = (payload as { listening?: unknown } | null)?.listening;
      if (typeof listening !== "boolean") return;
      if (listening === getFusedWakeStatus().listening) return;
      setFusedWakeStatus({ bridged: true, listening });
    },
  });
  if (loadWakeWordEnabled()) void armDesktopFusedWake();
  return () => {
    unsubscribe();
    unsubscribeState();
    void disarmDesktopFusedWake();
  };
}
