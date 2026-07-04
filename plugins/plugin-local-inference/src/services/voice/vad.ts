/**
 * Voice activity detection — the audio front-end's two-tier gate.
 *
 *   Tier 1 — `RmsEnergyGate`. A frame-level RMS threshold with hysteresis.
 *            Sub-frame latency, no model. Its rising edge is the "wake the
 *            response pipeline" signal (KV-prefill the response prompt,
 *            preload the drafter, pre-generate the first filler). It NEVER
 *            substitutes for the model VAD — it only decides "is there
 *            acoustic activity right now".
 *
 *   Tier 2 — a model VAD provider. Resolver order is an optional injected
 *            external VAD adapter when supplied, otherwise the fused
 *            `libelizainference` Silero v5 VAD ABI (`eliza_inference_vad_*`,
 *            backend id `silero-ggml`). 512-sample windows at 16 kHz (32 ms
 *            hop), one speech probability per window. This is the
 *            *authoritative* speech/no-speech signal — it gates ASR and drives
 *            turn-taking. The fused engine is the sole on-device VAD runtime;
 *            there is no standalone VAD library.
 *
 *   `VadDetector` wires both together and emits the `VadEvent` stream
 *   (`speech-start` / `speech-active` / `speech-pause` / `speech-end` /
 *   `blip`) plus the raw `EnergyGateEvent` stream.
 *
 * No fallback sludge: if the fused VAD ABI is unavailable (and no injected
 * adapter is supplied), `createVadDetector()` throws `VadUnavailableError`. The
 * caller surfaces "VAD unavailable — voice features degrade" — there is no
 * silent downgrade to the RMS gate, and no standalone-library fallback
 * (AGENTS.md §3).
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { localInferenceRoot } from "../paths";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
	NativeVadHandle,
} from "./ffi-bindings";
import type {
	EnergyGateEvent,
	EnergyGateListener,
	PcmFrame,
	VadEvent,
	VadEventListener,
} from "./types";
import {
	type BudgetReservation,
	ensureSharedVoiceBudget,
	reserveOrRamPressure,
	VAD_RESERVE_BYTES,
	type VoiceBudget,
} from "./voice-budget";

/** Thrown when the Silero VAD backend cannot be loaded — the native VAD FFI
 *  is missing or ABI-only, the model file is absent, or the model is corrupt.
 *  There is no fallback; voice features that depend on VAD must surface
 *  this. */
export class VadUnavailableError extends Error {
	readonly code:
		| "ffi-missing"
		| "model-missing"
		| "model-load-failed"
		| "provider-missing";
	constructor(code: VadUnavailableError["code"], message: string) {
		super(message);
		this.name = "VadUnavailableError";
		this.code = code;
	}
}

/** Relative paths of the fused Silero v5 model inside an Eliza-1 bundle. */
const SILERO_VAD_GGML_REL_PATH = path.join("vad", "silero-vad-v5.1.2.ggml.bin");
const SILERO_VAD_GGUF_REL_PATH = path.join("vad", "silero-vad-v5.gguf");
const SILERO_VAD_REL_PATHS = [
	SILERO_VAD_GGML_REL_PATH,
	SILERO_VAD_GGUF_REL_PATH,
] as const;

/**
 * Resolve the fused-libelizainference Silero GGML VAD model on disk. An
 * explicit `modelPath` is honored exactly — if it is set but missing, the
 * result is `null` (no silent substitution of a different model). When
 * `modelPath` is not given the search order is:
 *   1. `<bundleRoot>/vad/silero-vad-v5.1.2.ggml.bin`
 *   2. `<bundleRoot>/vad/silero-vad-v5.gguf`
 *   3. `<state-dir>/local-inference/vad/<same filenames>`
 *   3. `$ELIZA_VAD_MODEL_PATH`
 * Returns `null` when none exist.
 */
export function resolveSileroVadPath(opts: {
	modelPath?: string;
	bundleRoot?: string;
}): string | null {
	if (opts.modelPath) {
		return existsSync(opts.modelPath) ? path.resolve(opts.modelPath) : null;
	}
	const candidates: Array<string | undefined> = [
		...SILERO_VAD_REL_PATHS.map((rel) =>
			opts.bundleRoot ? path.join(opts.bundleRoot, rel) : undefined,
		),
		...SILERO_VAD_REL_PATHS.map((rel) => path.join(localInferenceRoot(), rel)),
		process.env.ELIZA_VAD_MODEL_PATH?.trim() || undefined,
	];
	for (const c of candidates) {
		if (c && existsSync(c)) return path.resolve(c);
	}
	return null;
}

const SILERO_WINDOW_16K = 512; // samples per inference window @ 16 kHz

function validateSileroSampleRate(sampleRate: number): void {
	if (sampleRate !== 16_000) {
		throw new VadUnavailableError(
			"model-load-failed",
			`[voice] Silero VAD v5 only supports 16 kHz; got ${sampleRate}. Resample the mic stream to 16 kHz before the VAD.`,
		);
	}
}

/**
 * Fused libelizainference-backed Silero v5 GGML VAD — the sole on-device VAD
 * runtime. The model (`silero-vad-v5.1.2.ggml.bin`) is loaded by the shared
 * ggml context owned by the FFI; `process()` runs one 512-sample 16 kHz window
 * through the native VAD and returns the speech probability. `reset()` clears
 * the recurrent state at utterance boundaries.
 */
export class GgmlSileroVad {
	readonly sampleRate: number;
	readonly windowSamples = SILERO_WINDOW_16K;
	private closed = false;
	/** Voice-budget reservation held while the native session is open. */
	private readonly reservation: BudgetReservation | null;

	private constructor(
		private readonly ffi: ElizaInferenceFfi,
		private readonly handle: NativeVadHandle,
		sampleRate: number,
		reservation: BudgetReservation | null,
	) {
		this.sampleRate = sampleRate;
		this.reservation = reservation;
	}

	/** True when the libelizainference build exports the native VAD ABI and
	 *  advertises support. False on ABI-only builds or when the C++ side has
	 *  not been linked against the GGML Silero VAD runtime. */
	static isSupported(ffi: ElizaInferenceFfi | null | undefined): boolean {
		if (!ffi || typeof ffi.vadSupported !== "function") return false;
		return ffi.vadSupported();
	}

	static async load(opts: {
		ffi: ElizaInferenceFfi;
		ctx: ElizaInferenceContextHandle | (() => ElizaInferenceContextHandle);
		sampleRate?: number;
		/** Voice-budget override; defaults to the process-wide shared budget. */
		budget?: VoiceBudget;
	}): Promise<GgmlSileroVad> {
		const sampleRate = opts.sampleRate ?? 16_000;
		validateSileroSampleRate(sampleRate);
		if (!GgmlSileroVad.isSupported(opts.ffi)) {
			throw new VadUnavailableError(
				"ffi-missing",
				"[voice] Native GGML Silero VAD is not supported by this libelizainference build. Rebuild with the GGML VAD runtime linked in (eliza_inference_vad_* symbols).",
			);
		}
		if (
			!opts.ffi.vadOpen ||
			!opts.ffi.vadProcess ||
			!opts.ffi.vadReset ||
			!opts.ffi.vadClose
		) {
			throw new VadUnavailableError(
				"model-load-failed",
				"[voice] Native GGML Silero VAD support probe succeeded, but the required VAD FFI methods are missing.",
			);
		}
		// Reserve before the native session opens; an over-budget arm throws
		// `VoiceLifecycleError("ram-pressure")` and nothing is loaded.
		const budget = opts.budget ?? (await ensureSharedVoiceBudget());
		const reservation = await reserveOrRamPressure(budget, {
			modelId: "silero-vad-v5",
			role: "vad",
			bytes: VAD_RESERVE_BYTES,
		});
		try {
			const ctx = typeof opts.ctx === "function" ? opts.ctx() : opts.ctx;
			const handle = opts.ffi.vadOpen({ ctx, sampleRateHz: sampleRate });
			return new GgmlSileroVad(opts.ffi, handle, sampleRate, reservation);
		} catch (err) {
			reservation.release();
			throw err;
		}
	}

	async process(window: Float32Array): Promise<number> {
		if (this.closed) {
			throw new Error("[voice] GgmlSileroVad.process called after close()");
		}
		if (window.length !== SILERO_WINDOW_16K) {
			throw new Error(
				`[voice] GgmlSileroVad.process expects a ${SILERO_WINDOW_16K}-sample window; got ${window.length}`,
			);
		}
		const vadProcess = this.ffi.vadProcess;
		if (!vadProcess) {
			throw new Error("[voice] GgmlSileroVad.process missing FFI method");
		}
		return vadProcess({ vad: this.handle, pcm: window });
	}

	reset(): void {
		if (this.closed) return;
		const vadReset = this.ffi.vadReset;
		if (!vadReset) {
			throw new Error("[voice] GgmlSileroVad.reset missing FFI method");
		}
		vadReset(this.handle);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		const vadClose = this.ffi.vadClose;
		if (!vadClose) {
			throw new Error("[voice] GgmlSileroVad.close missing FFI method");
		}
		vadClose(this.handle);
		this.reservation?.release();
	}
}

/** @deprecated Use `GgmlSileroVad`. Kept as an alias while callers migrate
 *  off the legacy ONNX-era name. */
export const NativeSileroVad = GgmlSileroVad;
export type NativeSileroVad = GgmlSileroVad;

// ---------------------------------------------------------------------------
// Tier 1: cheap always-on RMS energy gate.
// ---------------------------------------------------------------------------

export interface RmsEnergyGateConfig {
	/** RMS above this counts as activity. Default 0.012 — between the 0.01 the
	 *  vision capture stream uses and the 0.05 Discord uses for speaking. */
	riseThreshold?: number;
	/** RMS must drop below this to count as quiet (hysteresis). Default
	 *  `0.6 * riseThreshold`. */
	fallThreshold?: number;
	/** Consecutive ms below `fallThreshold` before emitting `energy-fall`.
	 *  Default 200 ms. */
	fallHoldMs?: number;
}

export function rms(pcm: Float32Array): number {
	if (pcm.length === 0) return 0;
	let sum = 0;
	for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
	return Math.sqrt(sum / pcm.length);
}

/**
 * Hysteretic RMS gate. Feed it `PcmFrame`s; it emits `energy-rise` on the
 * first frame above `riseThreshold` and `energy-fall` after RMS has been
 * below `fallThreshold` for `fallHoldMs`. This is the fast pre-warm trigger
 * — not a speech detector.
 */
export class RmsEnergyGate {
	private readonly riseThreshold: number;
	private readonly fallThreshold: number;
	private readonly fallHoldMs: number;
	private active = false;
	private quietSinceMs: number | null = null;
	private readonly listeners = new Set<EnergyGateListener>();

	constructor(config: RmsEnergyGateConfig = {}) {
		this.riseThreshold = config.riseThreshold ?? 0.012;
		this.fallThreshold = config.fallThreshold ?? this.riseThreshold * 0.6;
		this.fallHoldMs = config.fallHoldMs ?? 200;
	}

	get isActive(): boolean {
		return this.active;
	}

	onEvent(listener: EnergyGateListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Returns the frame RMS so callers can reuse it. */
	push(frame: PcmFrame): number {
		const level = rms(frame.pcm);
		if (!this.active) {
			if (level >= this.riseThreshold) {
				this.active = true;
				this.quietSinceMs = null;
				this.emit({
					type: "energy-rise",
					timestampMs: frame.timestampMs,
					rms: level,
				});
			}
			return level;
		}
		// active
		if (level < this.fallThreshold) {
			if (this.quietSinceMs === null) this.quietSinceMs = frame.timestampMs;
			const quietMs = frame.timestampMs - this.quietSinceMs;
			if (quietMs >= this.fallHoldMs) {
				this.active = false;
				this.quietSinceMs = null;
				this.emit({
					type: "energy-fall",
					timestampMs: frame.timestampMs,
					quietMs,
				});
			}
		} else {
			this.quietSinceMs = null;
		}
		return level;
	}

	reset(): void {
		this.active = false;
		this.quietSinceMs = null;
	}

	private emit(event: EnergyGateEvent): void {
		for (const l of this.listeners) l(event);
	}
}

// ---------------------------------------------------------------------------
// Tier 2 driver: VadDetector — the Silero speech state machine.
// ---------------------------------------------------------------------------

export interface VadDetectorConfig {
	/** Mic sample rate (Hz). MUST be 16 000 — Silero v5 is 16 kHz only. */
	sampleRate?: number;
	/** Speech probability above this opens a speech segment. Default 0.5. */
	onsetThreshold?: number;
	/** Speech probability must drop below this to count toward end-of-speech.
	 *  Default `onsetThreshold - 0.15`. Below the onset to avoid flapping. */
	offsetThreshold?: number;
	/** Consecutive ms of speech-prob below `offsetThreshold` before the
	 *  segment is considered *paused* (kick speculative response). Default
	 *  100 ms (lowered from 220ms; further reduction gated on semantic EOT
	 *  classifier V2). Override via `ELIZA_PAUSE_HANGOVER_MS`. */
	pauseHangoverMs?: number;
	/**
	 * V1 — "fast endpoint" pause hangover, used when `fastEndpointEnabled`
	 * is true. Default 100 ms — short enough that a clean trailing-off
	 * end-of-utterance hits the speculative path quickly, but long enough
	 * to ride out mid-sentence micro-pauses. Gated by the flag so callers
	 * can opt in once they've validated the false-positive rate on their
	 * hardware. Default 100 ms.
	 */
	fastPauseHangoverMs?: number;
	/**
	 * V1 — when true, use `fastPauseHangoverMs` instead of `pauseHangoverMs`.
	 * Default false until the streaming-ASR fast path (V2) ships.
	 */
	fastEndpointEnabled?: boolean;
	/**
	 * True when a semantic end-of-turn scorer (the fused `FfiEotScorer`
	 * composite) is live for this session. Decides the `endHangoverMs`
	 * default: 300 ms with a semantic gate in front, 500 ms fixed-VAD floor
	 * without one (research §1 — production fixed-VAD defaults cluster at
	 * 500 ms; ~200 ms is safe only when a semantic model makes the real
	 * call). Ignored when `endHangoverMs` is set explicitly.
	 */
	semanticEotActive?: boolean;
	/** Consecutive ms paused before the segment *ends* (finalize the turn).
	 *  Default `END_HANGOVER_SEMANTIC_EOT_MS` (300) when `semanticEotActive`,
	 *  else `END_HANGOVER_FIXED_VAD_MS` (500). Must be ≥ `pauseHangoverMs`. */
	endHangoverMs?: number;
	/** A segment shorter than this (from onset to end) is reclassified as a
	 *  `blip` rather than `speech-end`. Default 250 ms. */
	minSpeechMs?: number;
	/** Interval between `speech-active` heartbeats while speaking. Default
	 *  200 ms. */
	activeHeartbeatMs?: number;
	/**
	 * V4 — adaptive pause hangover. When the windowed RMS is in a sharp
	 * downward trend across the last few frames (the user audibly trailed
	 * off rather than stopping mid-thought), the hangover used to detect a
	 * pause is scaled by this factor (clamped to a minimum). Default 0.5
	 * (halve the hangover); set to 1.0 to disable.
	 */
	adaptiveHangoverScaleOnDrop?: number;
	/**
	 * V4 — minimum hangover the adaptive scale is allowed to produce, ms.
	 * Default 50 ms. Prevents a steep drop from collapsing the hangover to
	 * zero and emitting a pause on a single quiet frame.
	 */
	adaptiveHangoverFloorMs?: number;
	/**
	 * V4 — energy derivative (ΔRMS over the V4 history window) below this
	 * value, combined with RMS below `offsetThreshold`, counts as "audibly
	 * trailed off". Default -0.02 (negative slope: RMS dropping at least
	 * 0.02 / window).
	 */
	adaptiveHangoverDropThreshold?: number;
	/** RMS gate config (tier 1). */
	energyGate?: RmsEnergyGateConfig;
}

/**
 * Endpoint-wait defaults (issue #12254). The end-hangover is the silence the
 * user sits through between their last word and turn finalization — the
 * single largest tunable latency knob in the voice loop. With a semantic EOT
 * scorer live the acoustic wait can drop to 300 ms (the scorer catches
 * mid-thought pauses the timer cannot); without one, 500 ms is the
 * fixed-VAD floor (OpenAI/LiveKit production defaults — see
 * `research/VOICE_PIPELINE_RESEARCH_2026.md` §1). Never go below the floor
 * without a semantic gate.
 */
export const END_HANGOVER_SEMANTIC_EOT_MS = 300;
export const END_HANGOVER_FIXED_VAD_MS = 500;

type SegmentPhase = "idle" | "speaking" | "paused";

export type { VadLike } from "./types.js";

import type { VadLike } from "./types.js";

export type VadProviderId = "external-vad" | "silero-ggml";
export type VadProviderPreference = "auto" | VadProviderId;

export interface ExternalVadAdapter {
	isAvailable?(): boolean | Promise<boolean>;
	loadVad(opts: { sampleRate: number }): Promise<VadLike>;
}

export interface ResolvedVadProvider {
	id: VadProviderId;
	vad: VadLike;
}

export interface CreateVadDetectorOptions {
	modelPath?: string;
	bundleRoot?: string;
	ffi?: ElizaInferenceFfi | null;
	ctx?: ElizaInferenceContextHandle | (() => ElizaInferenceContextHandle);
	externalVad?: ExternalVadAdapter | null;
	config?: VadDetectorConfig;
	prefer?: VadProviderPreference;
	/** Voice-budget override; defaults to the process-wide shared budget. */
	budget?: VoiceBudget;
}

export function vadProviderOrder(
	prefer: VadProviderPreference = "auto",
): VadProviderId[] {
	if (prefer !== "auto") return [prefer];
	// `silero-ggml` is the fused `libelizainference` VAD ABI — the sole
	// on-device VAD runtime. The optional injected `external-vad` adapter is
	// tried first only when a caller supplies one; otherwise the fused engine
	// is the single path, and an unavailable fused VAD fails fast.
	return ["external-vad", "silero-ggml"];
}

export async function resolveVadProvider(
	opts: CreateVadDetectorOptions = {},
): Promise<ResolvedVadProvider> {
	const sampleRate = opts.config?.sampleRate ?? 16_000;
	const tried: string[] = [];
	const reasons: string[] = [];

	for (const provider of vadProviderOrder(opts.prefer)) {
		switch (provider) {
			case "external-vad": {
				tried.push(provider);
				if (!opts.externalVad) {
					reasons.push("external-vad: no adapter supplied");
					break;
				}
				const available = (await opts.externalVad.isAvailable?.()) ?? true;
				if (!available) {
					reasons.push("external-vad: adapter reported unavailable");
					break;
				}
				return {
					id: provider,
					vad: await opts.externalVad.loadVad({ sampleRate }),
				};
			}
			case "silero-ggml": {
				tried.push(provider);
				if (!opts.ffi || !opts.ctx) {
					reasons.push(
						"silero-ggml: libelizainference FFI / context not supplied",
					);
					break;
				}
				if (!GgmlSileroVad.isSupported(opts.ffi)) {
					reasons.push(
						"silero-ggml: libelizainference build does not export the VAD ABI (eliza_inference_vad_supported() == 0)",
					);
					break;
				}
				// Ensure the fused GGML model is on disk before opening the
				// native session. This keeps the failure mode "no model file"
				// distinct from a build with an ABI-only VAD.
				const modelPath = resolveSileroVadPath({
					modelPath: opts.modelPath,
					bundleRoot: opts.bundleRoot,
				});
				if (!modelPath) {
					throw new VadUnavailableError(
						"model-missing",
						`[voice] Fused Silero v5 GGML/GGUF VAD model not found. Looked for ${SILERO_VAD_REL_PATHS.join(" or ")} in the Eliza-1 bundle and under ${localInferenceRoot()}, or set ELIZA_VAD_MODEL_PATH.`,
					);
				}
				return {
					id: provider,
					vad: await GgmlSileroVad.load({
						ffi: opts.ffi,
						ctx: opts.ctx,
						sampleRate,
						...(opts.budget ? { budget: opts.budget } : {}),
					}),
				};
			}
		}
	}

	throw new VadUnavailableError(
		"provider-missing",
		`[voice] No VAD provider available. Tried: ${tried.join(", ")}. Reasons: ${reasons.join("; ") || "none reported"}.`,
	);
}

/**
 * The authoritative VAD. Owns a model VAD provider (or any `VadLike` for tests),
 * an `RmsEnergyGate`, and the speech state machine. `pushFrame()` accepts
 * mic frames of any length ≥ 1 sample; internally it re-windows to the
 * provider's fixed sample window. Emits `VadEvent`s on the VAD timeline and
 * `EnergyGateEvent`s on the fast timeline.
 *
 * Frame ingestion is serialized (`pushFrame` awaits the model forward pass)
 * so events stay in order; callers that can't await may fire-and-forget — a
 * dropped-frame counter (`droppedFrames`) records overruns.
 */
export class VadDetector {
	readonly silero: VadLike;
	readonly energyGate: RmsEnergyGate;
	private readonly sampleRate: number;
	private readonly onsetThreshold: number;
	private readonly offsetThreshold: number;
	private readonly pauseHangoverMs: number;
	private readonly fastPauseHangoverMs: number;
	private readonly fastEndpointEnabled: boolean;
	/** Effective endpoint hangover (ms) — public so session arm can log it. */
	readonly endHangoverMs: number;
	private readonly minSpeechMs: number;
	private readonly activeHeartbeatMs: number;
	// V4 — adaptive hangover state.
	private readonly adaptiveHangoverScaleOnDrop: number;
	private readonly adaptiveHangoverFloorMs: number;
	private readonly adaptiveHangoverDropThreshold: number;
	// Rolling RMS history (last 3 windows ≈ 96 ms @ 16 kHz / 512). The
	// sample-rate-of-drop check reads from this each window.
	private readonly recentRms: number[] = [];
	private static readonly RECENT_RMS_HISTORY = 3;

	private readonly vadListeners = new Set<VadEventListener>();

	private pending: Float32Array = new Float32Array(0);
	private windowDurationMs: number;
	private clockMs = 0; // timestamp of the *next* unconsumed sample
	private busy: Promise<void> = Promise.resolve();
	droppedFrames = 0;

	private phase: SegmentPhase = "idle";
	private speechStartMs = 0;
	private lastSpeechMs = 0; // last window whose prob ≥ offsetThreshold
	private pauseStartedMs = 0;
	private lastHeartbeatMs = 0;
	private peakRmsInSegment = 0;

	constructor(silero: VadLike, config: VadDetectorConfig = {}) {
		this.silero = silero;
		this.sampleRate = config.sampleRate ?? silero.sampleRate;
		if (this.sampleRate !== silero.sampleRate) {
			throw new Error(
				`[voice] VadDetector sample rate ${this.sampleRate} != Silero model rate ${silero.sampleRate}`,
			);
		}
		this.onsetThreshold = config.onsetThreshold ?? 0.5;
		this.offsetThreshold =
			config.offsetThreshold ?? Math.max(0.1, this.onsetThreshold - 0.15);
		// Lowered from 220ms; further reduction gated on semantic EOT classifier (V2).
		// Override via ELIZA_PAUSE_HANGOVER_MS env var.
		this.pauseHangoverMs =
			config.pauseHangoverMs ?? readPauseHangoverMsEnv() ?? 100;
		this.fastPauseHangoverMs = config.fastPauseHangoverMs ?? 100;
		this.fastEndpointEnabled = config.fastEndpointEnabled ?? false;
		this.endHangoverMs = Math.max(
			this.fastEndpointEnabled
				? this.fastPauseHangoverMs
				: this.pauseHangoverMs,
			config.endHangoverMs ??
				(config.semanticEotActive
					? END_HANGOVER_SEMANTIC_EOT_MS
					: END_HANGOVER_FIXED_VAD_MS),
		);
		this.minSpeechMs = config.minSpeechMs ?? 250;
		this.activeHeartbeatMs = config.activeHeartbeatMs ?? 200;
		this.adaptiveHangoverScaleOnDrop = Math.max(
			0.1,
			Math.min(1, config.adaptiveHangoverScaleOnDrop ?? 0.5),
		);
		this.adaptiveHangoverFloorMs = Math.max(
			0,
			config.adaptiveHangoverFloorMs ?? 50,
		);
		this.adaptiveHangoverDropThreshold =
			config.adaptiveHangoverDropThreshold ?? -0.02;
		this.energyGate = new RmsEnergyGate(config.energyGate);
		this.windowDurationMs = (silero.windowSamples / this.sampleRate) * 1000;
	}

	/**
	 * Effective pause hangover for this window. Starts from
	 * `fastPauseHangoverMs` or `pauseHangoverMs` (V1: gated on
	 * `fastEndpointEnabled`), then optionally scales it down when the RMS
	 * trajectory shows an audible trail-off (V4).
	 */
	private effectivePauseHangoverMs(): number {
		const base = this.fastEndpointEnabled
			? this.fastPauseHangoverMs
			: this.pauseHangoverMs;
		if (this.adaptiveHangoverScaleOnDrop >= 1) return base;
		// V4 — need at least two samples to compute a slope.
		if (this.recentRms.length < 2) return base;
		const first = this.recentRms[0];
		const last = this.recentRms[this.recentRms.length - 1];
		// Slope per window (we sample once per window). Negative = trailing off.
		const slope = (last - first) / (this.recentRms.length - 1);
		const lastBelowOffset = last < this.offsetThreshold;
		if (slope <= this.adaptiveHangoverDropThreshold && lastBelowOffset) {
			return Math.max(
				this.adaptiveHangoverFloorMs,
				base * this.adaptiveHangoverScaleOnDrop,
			);
		}
		return base;
	}

	onVadEvent(listener: VadEventListener): () => void {
		this.vadListeners.add(listener);
		return () => this.vadListeners.delete(listener);
	}

	onEnergyEvent(listener: EnergyGateListener): () => void {
		return this.energyGate.onEvent(listener);
	}

	/** True while a speech segment (incl. its pause hangover) is open. */
	get inSpeech(): boolean {
		return this.phase !== "idle";
	}

	/**
	 * Feed a mic frame. Returns a promise that resolves once every full
	 * Silero window contained in (the accumulated buffer up to) this frame
	 * has been processed and its events emitted. The fast RMS gate fires
	 * synchronously before the await.
	 */
	pushFrame(frame: PcmFrame): Promise<void> {
		if (frame.sampleRate !== this.sampleRate) {
			return Promise.reject(
				new Error(
					`[voice] VadDetector expects ${this.sampleRate} Hz frames; got ${frame.sampleRate}. Resample upstream of the VAD.`,
				),
			);
		}
		// Tier 1: synchronous, no model.
		this.energyGate.push(frame);

		const pcm = frame.pcm.slice();
		const timestampMs = frame.timestampMs;
		const run = this.busy.then(async () => {
			// Anchor the clock to the first frame so timestamps are mic-domain.
			if (this.pending.length === 0 && this.clockMs === 0) {
				this.clockMs = timestampMs;
			}
			// Append to the re-windowing buffer while holding the serialized
			// drain chain. Fire-and-forget callers can overlap model inference;
			// the shared pending buffer must still advance one frame at a time.
			const merged = new Float32Array(this.pending.length + pcm.length);
			merged.set(this.pending, 0);
			merged.set(pcm, this.pending.length);
			this.pending = merged;
			await this.drainWindows();
		});
		// Keep the chain alive even if a window throws (the throw still
		// surfaces via the returned promise).
		this.busy = run.catch(() => {
			this.droppedFrames++;
		});
		return run;
	}

	/** Flush any partial trailing samples (zero-padded to a full window) and
	 *  finalize an open segment. Call at end-of-stream. */
	flush(): Promise<void> {
		const run = this.busy.then(async () => {
			if (this.pending.length > 0) {
				const w = new Float32Array(this.silero.windowSamples);
				w.set(this.pending.subarray(0, this.silero.windowSamples));
				this.pending = new Float32Array(0);
				await this.processWindow(w);
			}
			if (this.phase !== "idle") {
				this.endSegment(this.clockMs);
			}
		});
		this.busy = run.catch(() => {
			this.droppedFrames++;
		});
		return run;
	}

	reset(): void {
		this.pending = new Float32Array(0);
		this.clockMs = 0;
		this.phase = "idle";
		this.peakRmsInSegment = 0;
		this.recentRms.length = 0;
		this.silero.reset();
		this.energyGate.reset();
	}

	private async drainWindows(): Promise<void> {
		const win = this.silero.windowSamples;
		while (this.pending.length >= win) {
			const w = this.pending.subarray(0, win);
			// Copy out so the slice is stable across the await.
			const window = w.slice();
			this.pending = this.pending.subarray(win);
			await this.processWindow(window);
		}
	}

	private async processWindow(window: Float32Array): Promise<void> {
		const prob = await this.silero.process(window);
		const windowRms = rms(window);
		// V4 — keep a short rolling RMS history for the energy-rate-of-drop
		// adaptive hangover. Three windows ≈ 96 ms at 16 kHz / 512 samples.
		this.recentRms.push(windowRms);
		if (this.recentRms.length > VadDetector.RECENT_RMS_HISTORY) {
			this.recentRms.shift();
		}
		// Clock at the *end* of this window.
		this.clockMs += this.windowDurationMs;
		const now = this.clockMs;
		const isSpeechFrame = prob >= this.onsetThreshold;
		const aboveOffset = prob >= this.offsetThreshold;

		switch (this.phase) {
			case "idle": {
				if (isSpeechFrame) {
					this.phase = "speaking";
					this.speechStartMs = now - this.windowDurationMs;
					this.lastSpeechMs = now;
					this.lastHeartbeatMs = now;
					this.peakRmsInSegment = windowRms;
					this.emit({
						type: "speech-start",
						timestampMs: this.speechStartMs,
						probability: prob,
					});
				}
				break;
			}
			case "speaking": {
				this.peakRmsInSegment = Math.max(this.peakRmsInSegment, windowRms);
				if (aboveOffset) {
					this.lastSpeechMs = now;
				}
				const quietMs = now - this.lastSpeechMs;
				if (quietMs >= this.effectivePauseHangoverMs()) {
					this.phase = "paused";
					this.pauseStartedMs = this.lastSpeechMs;
					this.emit({
						type: "speech-pause",
						timestampMs: now,
						pauseDurationMs: quietMs,
					});
				} else if (now - this.lastHeartbeatMs >= this.activeHeartbeatMs) {
					this.lastHeartbeatMs = now;
					this.emit({
						type: "speech-active",
						timestampMs: now,
						probability: prob,
						speechDurationMs: now - this.speechStartMs,
					});
				}
				break;
			}
			case "paused": {
				this.peakRmsInSegment = Math.max(this.peakRmsInSegment, windowRms);
				if (isSpeechFrame) {
					// Speech resumed before end-of-utterance.
					this.phase = "speaking";
					this.lastSpeechMs = now;
					this.lastHeartbeatMs = now;
					this.emit({
						type: "speech-active",
						timestampMs: now,
						probability: prob,
						speechDurationMs: now - this.speechStartMs,
					});
				} else {
					const pauseMs = now - this.pauseStartedMs;
					if (pauseMs >= this.endHangoverMs) {
						this.endSegment(now);
					} else {
						this.emit({
							type: "speech-pause",
							timestampMs: now,
							pauseDurationMs: pauseMs,
						});
					}
				}
				break;
			}
		}
	}

	private endSegment(now: number): void {
		const speechDurationMs = this.lastSpeechMs - this.speechStartMs;
		const peakRms = this.peakRmsInSegment;
		this.phase = "idle";
		this.peakRmsInSegment = 0;
		this.silero.reset();
		if (speechDurationMs < this.minSpeechMs) {
			this.emit({
				type: "blip",
				timestampMs: now,
				durationMs: Math.max(0, speechDurationMs),
				peakRms,
			});
			return;
		}
		this.emit({ type: "speech-end", timestampMs: now, speechDurationMs });
	}

	private emit(event: VadEvent): void {
		for (const l of this.vadListeners) l(event);
	}
}

/**
 * Back-compat wrapper for callers that still use the legacy
 * `createSileroVadDetector` name. It now goes through the full provider
 * resolver — same as `createVadDetector`.
 */
export async function createSileroVadDetector(
	opts: CreateVadDetectorOptions = {},
): Promise<VadDetector> {
	return createVadDetector(opts);
}

/**
 * Convenience: resolve the best available model VAD provider and wrap it in a
 * `VadDetector`.
 */
export async function createVadDetector(
	opts: CreateVadDetectorOptions = {},
): Promise<VadDetector> {
	const { vad } = await resolveVadProvider(opts);
	return new VadDetector(vad, opts.config);
}

/**
 * Read `ELIZA_PAUSE_HANGOVER_MS` from the environment. Returns a positive
 * integer when the variable is set and valid, otherwise `undefined`.
 */
function readPauseHangoverMsEnv(): number | undefined {
	const raw = process.env.ELIZA_PAUSE_HANGOVER_MS?.trim();
	if (!raw) return undefined;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}
