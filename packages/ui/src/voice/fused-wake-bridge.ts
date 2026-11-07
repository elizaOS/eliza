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
 * capability. The host reports its detector through {@link setFusedWakeStatus},
 * which sets `window.__ELIZA_FUSED_WAKE__` only while the detector is running
 * ({@link probeFusedWake} only gates the default capability set, it does not
 * invent a subscription).
 *
 * Keeping the transport a plain DOM CustomEvent means it is identical to drive
 * from the native bridge, a WebSocket push handler, or a synthetic test — which
 * is exactly how the Phase 2 integration test exercises it.
 */

import type { FusedWakeEventDetail } from "@elizaos/core/protocol";
import { FUSED_WAKE_EVENT } from "@elizaos/core/protocol";
/**
 * A single fused-wake stage forwarded from the native runtime to the UI. This
 * is the canonical {@link FusedWakeEventDetail} contract from `@elizaos/core`
 * — the same type the producer (`@elizaos/plugin-local-inference`) emits, so the
 * two halves can never drift.
 */
export type FusedWakeEvent = FusedWakeEventDetail;
declare global {
  interface Window {
    /** True while a fused on-device wake detector is running and can fire. */
    __ELIZA_FUSED_WAKE__?: boolean;
  }
}

export { FUSED_WAKE_EVENT };

/** What the native host reported about its fused wake detector. */
export interface FusedWakeStatus {
  /** A native host owns a fused wake detector this renderer can arm. */
  bridged: boolean;
  /** The detector is running. Only then can a wake fire. */
  listening: boolean;
  /** Why the detector is not running, as reported by the host. */
  reason?: string;
}

let fusedWakeStatus: FusedWakeStatus = { bridged: false, listening: false };
const fusedWakeStatusListeners = new Set<() => void>();

/** The last detector status the host reported. Stable between updates. */
export function getFusedWakeStatus(): FusedWakeStatus {
  return fusedWakeStatus;
}

/**
 * Record the detector status reported by the native host. Mirrors `listening`
 * onto `window.__ELIZA_FUSED_WAKE__`, so the capability {@link probeFusedWake}
 * reports is the detector's real state, not the mere presence of a host.
 */
export function setFusedWakeStatus(next: FusedWakeStatus): void {
  fusedWakeStatus = next;
  if (typeof window !== "undefined") {
    window.__ELIZA_FUSED_WAKE__ = next.listening;
  }
  for (const listener of fusedWakeStatusListeners) listener();
}

/** Subscribe to detector status changes. Returns an unsubscribe fn. */
export function subscribeFusedWakeStatus(listener: () => void): () => void {
  fusedWakeStatusListeners.add(listener);
  return () => {
    fusedWakeStatusListeners.delete(listener);
  };
}

/**
 * Whether a fused on-device wake detector is running. Seeds the default
 * capability set; emission still drives detection.
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
