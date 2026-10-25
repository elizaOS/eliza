/**
 * Narrow standalone-wake barrel (`@elizaos/plugin-local-inference/voice-wake`).
 *
 * Re-exports ONLY the light, self-contained pieces needed to run the standalone
 * `wakeword-cpp` detector (`bun:ffi` → `libwakeword`) on a raw mic stream and map
 * each fire to the shared `eliza:fused-wake` contract — with NO transitive edge
 * into the fused `libelizainference` engine, llama.cpp, image generation, or the
 * rest of the local-inference graph. This is the seam the desktop electrobun main
 * process uses to run the on-device wake detector and forward `voice:fusedWake`
 * to the renderer (#10351) without bloating the lean main bundle.
 *
 * The standalone path is deliberately preferred over `loadBundledWakeWordModel`,
 * which requires the fused FFI handle the main process does not own; the detector
 * loads its three GGUFs + `libwakeword` directly via
 * {@link resolveWakeWordStandalonePaths} + `OpenWakeWordGgmlModel`, and
 * {@link bridgeDetectorToFusedWake} maps its `onWake(WakeFireInfo)` to the
 * canonical `FusedWakeEventDetail` sink.
 */

export {
	bridgeDetectorToFusedWake,
	type FusedWakeSink,
} from "./services/voice/fused-wake-bridge";
export { DesktopMicSource } from "./services/voice/mic-source";
export type { PcmFrame } from "./services/voice/types";
export {
	OPENWAKEWORD_DEFAULT_HEAD,
	OpenWakeWordDetector,
	resolveWakeWordStandalonePaths,
	type WakeFireInfo,
	type WakeWordStandalonePaths,
} from "./services/voice/wake-word";
export { OpenWakeWordGgmlModel } from "./services/voice/wake-word-ggml";
