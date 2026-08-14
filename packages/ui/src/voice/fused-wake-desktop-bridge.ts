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
 * Ordering matters: {@link useWakeController} seeds its capability set once at
 * mount via `probeFusedWake()` (`window.__ELIZA_FUSED_WAKE__`). Call
 * {@link registerDesktopFusedWake} at renderer boot, BEFORE React mounts the
 * shell, so `openWakeWord` is enabled for the first render.
 */

import {
  getElectrobunRendererRpc,
  invokeDesktopBridgeRequest,
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
 * Wire the desktop fused-wake channel into the renderer without opening the
 * microphone. The wake controller starts the detector only after the persisted
 * user opt-in and owns the corresponding stop. On a non-desktop host (no
 * electrobun RPC) this is a no-op, leaving the capability flag unset so
 * {@link useWakeController} keeps the Swabble fallback.
 */
export function registerDesktopFusedWake(): () => void {
  if (!getElectrobunRendererRpc()) return () => {};
  if (typeof window !== "undefined") {
    window.__ELIZA_FUSED_WAKE__ = true;
  }
  const unsubscribe = subscribeDesktopBridgeEvent({
    rpcMessage: DESKTOP_FUSED_WAKE_MESSAGE,
    ipcChannel: DESKTOP_FUSED_WAKE_MESSAGE,
    listener: (payload) => {
      const event = toFusedWakeEvent(payload);
      if (event) emitFusedWake(event);
    },
  });
  return () => {
    unsubscribe();
    if (typeof window !== "undefined") {
      window.__ELIZA_FUSED_WAKE__ = false;
    }
  };
}

export interface DesktopFusedWakeStartResult {
  started: boolean;
  reason?: string;
}

/** Query the native detector without changing microphone state. */
export async function isDesktopFusedWakeListening(): Promise<boolean | null> {
  const result = await invokeDesktopBridgeRequest<{ listening: boolean }>({
    rpcMethod: "fusedWakeIsListening",
    ipcChannel: "fusedWake:isListening",
  });
  return result?.listening ?? null;
}

/** Start the registered native detector after the user has opted in. */
export async function startDesktopFusedWake(
  head: string,
): Promise<DesktopFusedWakeStartResult> {
  const result = await invokeDesktopBridgeRequest<DesktopFusedWakeStartResult>({
    rpcMethod: "fusedWakeStart",
    ipcChannel: "fusedWake:start",
    params: { head },
  });
  return (
    result ?? {
      started: false,
      reason: "desktop-wake-bridge-unavailable",
    }
  );
}

/** Stop a native detector lifecycle previously started by the wake controller. */
export async function stopDesktopFusedWake(): Promise<void> {
  await invokeDesktopBridgeRequest({
    rpcMethod: "fusedWakeStop",
    ipcChannel: "fusedWake:stop",
  });
}
