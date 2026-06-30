/**
 * Renderer bridge for the fused on-device wake path (#9953 / #9880).
 *
 * The battery-efficient fused openWakeWord runtime (`libwakeword` via
 * `wake-word-ggml.ts`, exercised by `wakeword-cpp`) runs in the agent/native
 * process, not the renderer. Per `VOICE_UX.md`, only the Swabble Web-Speech
 * fallback was ever bridged to the UI; the fused path was built + tested but
 * never reached `useWakeController`.
 *
 * This module is the missing seam: the native host forwards fused wake stages to
 * the renderer as a `window` CustomEvent, and `useWakeController` subscribes to
 * them through {@link subscribeFusedWake} when it declares the `openWakeWord`
 * capability. The host signals availability by setting
 * `window.__ELIZA_FUSED_WAKE__ = true` before the controller mounts (or it can
 * just start emitting events — {@link probeFusedWake} only gates the default
 * capability set, it does not invent a subscription).
 *
 * Keeping the transport a plain DOM CustomEvent means it is identical to drive
 * from the native bridge, a WebSocket push handler, or a synthetic test — which
 * is exactly how the Phase 2 integration test exercises it.
 */

import {
  FUSED_WAKE_EVENT,
  type FusedWakeEventDetail,
} from "@elizaos/shared/events";

/**
 * A single fused-wake stage forwarded from the native runtime to the UI. This
 * is the canonical {@link FusedWakeEventDetail} contract from `@elizaos/shared`
 * — the same type the producer (`@elizaos/plugin-local-inference`) emits, so the
 * two halves can never drift.
 */
export type FusedWakeEvent = FusedWakeEventDetail;

declare global {
  interface Window {
    /** Set by the native host when the fused on-device wake runtime is live. */
    __ELIZA_FUSED_WAKE__?: boolean;
  }
}

export { FUSED_WAKE_EVENT };

/**
 * Whether the fused on-device wake runtime is available to the renderer. Only
 * used to seed the default capability set; emission still drives detection.
 */
export function probeFusedWake(): boolean {
  return typeof window !== "undefined" && window.__ELIZA_FUSED_WAKE__ === true;
}

/** Forward a fused wake stage to the UI (native host / WS handler / test). */
export function emitFusedWake(event: FusedWakeEvent): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<FusedWakeEvent>(FUSED_WAKE_EVENT, { detail: event }),
  );
}

/**
 * Subscribe to fused wake stages. Returns an unsubscribe fn. No-ops (returns a
 * no-op cleanup) when there is no `window` (SSR / Node tests without jsdom).
 */
export function subscribeFusedWake(
  listener: (event: FusedWakeEvent) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<FusedWakeEvent>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(FUSED_WAKE_EVENT, handler);
  return () => window.removeEventListener(FUSED_WAKE_EVENT, handler);
}
