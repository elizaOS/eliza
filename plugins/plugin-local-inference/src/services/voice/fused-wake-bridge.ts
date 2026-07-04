/**
 * Producer side of the fused on-device wake bridge (#10351).
 *
 * The battery-efficient native openWakeWord runtime (`libwakeword` via
 * `wake-word-ggml.ts`, wrapped by {@link OpenWakeWordDetector}) runs in the
 * agent/native (Bun) process. Its firing must reach the renderer, where
 * `useWakeController` (`@elizaos/ui`) activates the bottom bar and starts a
 * turn. Without this seam nothing forwards the native detector's firing to the
 * renderer, and the bar is driven only by the Swabble Web-Speech fallback.
 *
 * This module supplies that seam: it adapts an {@link OpenWakeWordDetector}
 * firing into a canonical {@link FusedWakeEventDetail} and hands it to a
 * {@link FusedWakeSink}. The host wires the sink to its renderer transport
 * (Capacitor event / Electrobun RPC / WebSocket push) where the renderer's
 * `emitFusedWake` dispatches the `eliza:fused-wake` window event. The event
 * shape is the same `@elizaos/shared` contract the renderer consumes, so the
 * two halves can never drift.
 */

import type { FusedWakeEventDetail } from "@elizaos/shared/events";
import type { WakeFireInfo } from "./wake-word";

export type {
	FusedWakeEventDetail,
	FusedWakeStage,
} from "@elizaos/shared/events";

/**
 * Sink the host wires to forward a fused-wake stage to the renderer. The
 * transport is the host's concern; this seam is transport-agnostic, which is
 * exactly why the same sink can be driven by a real detector, a live host
 * bridge, or an integration test.
 */
export type FusedWakeSink = (event: FusedWakeEventDetail) => void;

/**
 * Build the {@link OpenWakeWordDetector} `onWake` callback that bridges a real
 * native head-fire into a fused-wake stage on `sink`.
 *
 * The bundled head (`hey-eliza`, or an auto-trained head) is name-aware, so a
 * fire is terminal — it maps to the `head-fired` stage with no ASR confirmation
 * (the head fast-path in `wake-controller.ts`). The classifier probability that
 * crossed threshold rides along as `confidence`.
 */
export function bridgeDetectorToFusedWake(
	sink: FusedWakeSink,
): (info: WakeFireInfo) => void {
	return (info: WakeFireInfo): void => {
		sink({ stage: "head-fired", confidence: info.confidence });
	};
}
