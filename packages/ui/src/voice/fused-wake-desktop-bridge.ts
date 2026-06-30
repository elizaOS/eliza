/**
 * Desktop transport for the fused on-device wake path (#10351).
 *
 * The battery-efficient openWakeWord runtime (`libwakeword` via
 * `wake-word-ggml.ts`) runs in the desktop agent/Bun process, not the renderer.
 * When a real wake fires, the desktop voice bootstrap emits a `voice:fusedWake`
 * message over the electrobun runtime→renderer channel carrying the
 * `WakeFireEvent` shape (`{ stage: "head-fired", confidence }`). This module is
 * the renderer end of that channel: it forwards each message to
 * {@link emitFusedWake}, so the existing {@link useWakeController} subscription
 * activates the bottom bar exactly as a synthetic test or the Swabble fallback
 * would — closing the "fused path built + tested but never bridged" gap.
 *
 * On non-desktop hosts (no electrobun RPC) registration is a no-op and the
 * Swabble Web-Speech fallback path is left untouched.
 *
 * Ordering matters: {@link useWakeController} seeds its capability set once at
 * mount via `probeFusedWake()` (`window.__ELIZA_FUSED_WAKE__`). Call
 * {@link registerDesktopFusedWake} at renderer boot, BEFORE React mounts the
 * shell, so `openWakeWord` is enabled for the first render.
 */

import {
  getElectrobunRendererRpc,
  subscribeDesktopBridgeEvent,
} from "../bridge/electrobun-rpc";
import { emitFusedWake, type FusedWakeEvent } from "./fused-wake-bridge";

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

/**
 * Wire the desktop fused-wake channel into the renderer.
 *
 * Returns an unsubscribe function. On a non-desktop host (no electrobun RPC) it
 * is a no-op that returns a no-op cleanup, leaving `window.__ELIZA_FUSED_WAKE__`
 * unset so {@link useWakeController} keeps the Swabble fallback.
 */
export function registerDesktopFusedWake(): () => void {
  if (!getElectrobunRendererRpc()) return () => {};
  if (typeof window !== "undefined") {
    window.__ELIZA_FUSED_WAKE__ = true;
  }
  return subscribeDesktopBridgeEvent({
    rpcMessage: DESKTOP_FUSED_WAKE_MESSAGE,
    ipcChannel: DESKTOP_FUSED_WAKE_MESSAGE,
    listener: (payload) => {
      const event = toFusedWakeEvent(payload);
      if (event) emitFusedWake(event);
    },
  });
}
