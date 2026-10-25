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
 *   - the AOSP local-inference bootstrap, to choose the in-process FFI
 *     streaming path,
 *   - the desktop voice lifecycle service, to decide whether to wire the
 *     FFI streaming runner factory,
 *   - UI surfaces (model picker, voice toggle) that hide options the
 *     loaded build cannot honour.
 *
 * Naming:
 *   - `streamingLlm` — `eliza_inference_llm_stream_*` symbols are
 *     resolved and the build reports `_supported() === 1`.
 *   - `mtpSupported` — native MTP speculative decoding can actually run.
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
	mtpSupported: boolean;
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
	/** True only when the native MTP path is available for the loaded model. */
	mtpResident(): boolean;
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
 *   - Native MTP only fires when `llmStreamSupported` and the thermal state is
 *     at most `fair`.
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
	const mtpResident = probes.mtpResident();
	const mmprojResident = probes.mmprojResident();
	const thermalState = probes.thermalState();
	const platform = probes.platform();

	const thermalBlocksMtp =
		thermalState === "serious" || thermalState === "critical";

	const mtpSupported = streamingLlm && mtpResident && !thermalBlocksMtp;

	return {
		streamingLlm,
		mtpSupported,
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
		mtpSupported: false,
		omnivoiceStreaming: false,
		mmprojSupported: false,
		thermalState: "nominal",
		platform: "unknown",
	};
}

// ---------------------------------------------------------------------------
// Sampled resource snapshot + thermal-throttle decision
// ---------------------------------------------------------------------------

/**
 * A live, *sampled* device-resource snapshot from the native probe
 * (iOS `getResourceSnapshot`, Android `ResourceProbe.getResourceSnapshot`) — as
 * opposed to the one-shot `InferenceCapabilities` probe. The Mobile Resource
 * Workbench (issue #8800) samples these on an interval across a sustained
 * workload to build a thermal/RSS/battery timeline. Every numeric field is
 * `null` when the platform could not measure it — never a fabricated zero.
 */
export interface ResourceSnapshot {
	/** Current thermal state; `"unknown"` on platforms without a thermal API. */
	thermalState: ThermalState | "unknown";
	/** Whether the OS low-power / battery-saver mode is engaged, or null. */
	lowPowerMode: boolean | null;
	/** Process resident set size in MB, or null. */
	residentMemoryMb: number | null;
	/** Device-wide available RAM in MB, or null. */
	availableRamMb: number | null;
	/** Cumulative process CPU time in ms, or null. */
	cpuTimeMs: number | null;
	/** Battery level 0..100, or null. */
	batteryLevelPct: number | null;
	/** Sample timestamp in ms (epoch). */
	capturedAtMs: number;
}

export interface ThermalThrottleDecision {
	/**
	 * Whether speculative decoding (MTP) should be disabled for the next step.
	 * MTP burns extra compute for a latency win; under heat that trade flips.
	 */
	throttleSpeculativeDecode: boolean;
	/**
	 * Whether to proactively shed load (shrink batch / context, pause warmups)
	 * because the device is at the top of the thermal range.
	 */
	reduceLoad: boolean;
	reason: string;
}

const THROTTLE_SEVERITY: Record<ThermalState, number> = {
	nominal: 0,
	fair: 1,
	serious: 2,
	critical: 3,
};

/**
 * Decide whether to throttle on-device inference for the current thermal /
 * power state. Pure and synchronous so the streaming path can call it per token
 * (the `ProcessInfo.thermalState` throttle hook the iOS streaming bridge still
 * lists as a TODO) and the workbench can assert the policy without a device.
 *
 *   - `serious` / `critical` thermal → stop speculative decoding (matches the
 *     existing one-shot MTP gate in `probeCapabilities`).
 *   - `critical` thermal → additionally shed load.
 *   - low-power mode → stop speculative decoding (honour the user's power intent).
 *   - `unknown` thermal with no low-power signal → do not throttle (don't
 *     penalise a device that simply lacks a thermal API).
 */
export function thermalThrottleDecision(input: {
	thermalState: ThermalState | "unknown";
	lowPowerMode?: boolean | null;
}): ThermalThrottleDecision {
	const lowPower = input.lowPowerMode === true;
	if (input.thermalState === "unknown") {
		return {
			throttleSpeculativeDecode: lowPower,
			reduceLoad: false,
			reason: lowPower
				? "low-power mode (thermal state unknown)"
				: "thermal state unknown — no throttle",
		};
	}
	const severity = THROTTLE_SEVERITY[input.thermalState];
	const thermalThrottles = severity >= THROTTLE_SEVERITY.serious;
	const reduceLoad = severity >= THROTTLE_SEVERITY.critical;
	const throttleSpeculativeDecode = thermalThrottles || lowPower;
	let reason: string;
	if (reduceLoad) reason = `thermal ${input.thermalState} — shed load`;
	else if (thermalThrottles)
		reason = `thermal ${input.thermalState} — throttle speculative decode`;
	else if (lowPower) reason = "low-power mode — throttle speculative decode";
	else reason = `thermal ${input.thermalState} — nominal, no throttle`;
	return { throttleSpeculativeDecode, reduceLoad, reason };
}
