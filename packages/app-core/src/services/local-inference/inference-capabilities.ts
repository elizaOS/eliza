/**
 * Inference capability detection.
 *
 * Centralises "what does this device's local-inference stack expose"
 * into one struct the runtime can read at startup.  The shape mirrors
 * the per-platform binding probes (Android + iOS + desktop FFI) so the
 * runtime doesn't have to import each platform's adapter just to
 * surface the bits.
 *
 * Consumed by:
 *   - the AOSP local-inference bootstrap, to choose between the
 *     in-process FFI streaming path and the (now-removed) child-process
 *     `llama-server` path,
 *   - the desktop voice lifecycle service, to decide whether to wire
 *     the FFI streaming runner factory or fall back to the HTTP
 *     `dflash-server.ts`,
 *   - UI surfaces (model picker, voice toggle) that hide options the
 *     loaded build cannot honour.
 *
 * Naming:
 *   - `streamingLlm` — `eliza_inference_llm_stream_*` symbols are
 *     resolved and the build reports `_supported() === 1`.
 *   - `dflashSupported` — speculative decoding can actually run
 *     (requires `streamingLlm` AND the drafter weights resident; mobile
 *     phases this in — see `docs/eliza-1-mobile-streaming-llm.md`).
 *   - `omnivoiceStreaming` — `eliza_inference_tts_synthesize_stream` is
 *     present and supported.
 *   - `mmprojSupported` — the build carries the multi-modal projector
 *     and the device has the headroom to keep it resident.
 *   - `thermalState` — best-effort current thermal snapshot from the
 *     platform (`ProcessInfo.thermalState` on iOS,
 *     `PowerManager.getCurrentThermalStatus` on Android).
 *
 * All fields are read-only snapshots; the runtime re-probes on resume.
 */

export type ThermalState = "nominal" | "fair" | "serious" | "critical";

export interface InferenceCapabilities {
  streamingLlm: boolean;
  dflashSupported: boolean;
  omnivoiceStreaming: boolean;
  mmprojSupported: boolean;
  thermalState: ThermalState;
  /** Platform tag for diagnostics + routing. */
  platform: "android" | "ios" | "desktop" | "unknown";
}

/** Minimal probe surface — what the caller hands in. */
export interface CapabilityProbes {
  /** True only when `eliza_inference_llm_stream_supported()` returns 1. */
  llmStreamSupported(): boolean;
  /** True only when `eliza_inference_tts_stream_supported()` returns 1. */
  ttsStreamSupported(): boolean;
  /** True only when the drafter GGUF is resident in the bundle + mapped. */
  drafterResident(): boolean;
  /** True only when the mmproj weights are present in the bundle. */
  mmprojResident(): boolean;
  /** Current thermal snapshot.  May return `nominal` on platforms without a thermal API. */
  thermalState(): ThermalState;
  /** Platform tag. */
  platform(): "android" | "ios" | "desktop" | "unknown";
}

/**
 * Build a capability struct from a set of probes.
 *
 * Policy decisions encoded here:
 *   - DFlash speculative decoding only fires when `llmStreamSupported`
 *     AND the drafter is resident AND the thermal state is at most
 *     `fair`.  Phone budgets cannot afford the extra weights map and a
 *     serious / critical thermal state already means the OS is going to
 *     start clock-gating us.
 *   - mmproj is gated entirely on the bundle carrying it.  Devices
 *     short on RAM can still load the chat model — they just lose the
 *     vision path; the picker UI uses this bit to grey out vision
 *     uploads.
 *   - omnivoice streaming is gated entirely on the FFI build: the JS
 *     side has no fallback path for streaming TTS, only for batch.
 */
export function probeCapabilities(
  probes: CapabilityProbes,
): InferenceCapabilities {
  const streamingLlm = probes.llmStreamSupported();
  const omnivoiceStreaming = probes.ttsStreamSupported();
  const drafterResident = probes.drafterResident();
  const mmprojResident = probes.mmprojResident();
  const thermalState = probes.thermalState();
  const platform = probes.platform();

  const thermalBlocksDflash =
    thermalState === "serious" || thermalState === "critical";

  const dflashSupported =
    streamingLlm && drafterResident && !thermalBlocksDflash;

  return {
    streamingLlm,
    dflashSupported,
    omnivoiceStreaming,
    mmprojSupported: mmprojResident,
    thermalState,
    platform,
  };
}

/**
 * Defaults probe: every flag off, platform `unknown`, thermal `nominal`.
 * Used by the runtime when no FFI binding could be loaded (cloud-only
 * fallback path).  Surfaces as a single struct the UI can render
 * without branching on "no probe registered".
 */
export function defaultsForNoBinding(): InferenceCapabilities {
  return {
    streamingLlm: false,
    dflashSupported: false,
    omnivoiceStreaming: false,
    mmprojSupported: false,
    thermalState: "nominal",
    platform: "unknown",
  };
}
