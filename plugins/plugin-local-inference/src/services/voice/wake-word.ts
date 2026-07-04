/**
 * Wake-word detection (openWakeWord) — opt-in, local-mode only.
 *
 * Replaces the previous `onnxruntime-node`-backed implementation with a
 * pure GGML / llama.cpp path. The three-stage openWakeWord pipeline (mel
 * filterbank → speech embedding model → per-phrase classifier head) is
 * compiled into one combined GGUF
 * (`wake/openwakeword.gguf`, produced by
 * `packages/training/scripts/wakeword/convert_openwakeword_to_gguf.py`)
 * and executed natively by the fused `libelizainference` build via the
 * `eliza_inference_wakeword_*` FFI surface (ABI v5).
 *
 * The JS side is now a thin adapter over that surface — there is NO ONNX
 * fallback. When the fused library was built without the wake-word
 * runtime, the JS path throws a structured `WakeWordUnavailableError`
 * (AGENTS.md §3, §8 — no silent fallbacks).
 *
 * Per `packages/inference/AGENTS.md` §1 + the three-mode rules (§1, §5):
 *   - openWakeWord (Apache-2.0, ~3 MB) ships in the bundle but is
 *     **opt-in**: voice mode works without it (push-to-talk / VAD-gated).
 *   - It is **local-mode only**. In `cloud` mode the surface is hidden
 *     *and inert* (hide-not-disable §5): the model is not loaded, the
 *     setting is rejected by the API, no background job runs it.
 *   - Detections feed the same place a push-to-talk press would: they arm
 *     a listening window that the VAD gate then bounds.
 *
 * Streaming pipeline shape (16 kHz mono):
 *   - 1280-sample (80 ms) PCM frames per `scoreFrame` call.
 *   - Internally: mel filterbank → 32-bin frames; embedding model windows
 *     76 mel frames, hop 8 → 96-dim embedding; head windows 16 embeddings
 *     → P(wake) in [0, 1].
 *   - The native runtime owns the audio tail, mel ring and embedding
 *     ring; the JS side feeds frames and reads back probabilities.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { localInferenceRoot } from "../paths";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
	NativeWakeWordHandle,
} from "./ffi-bindings";
import {
	type BudgetReservation,
	ensureSharedVoiceBudget,
	reserveOrRamPressure,
	type VoiceBudget,
	WAKE_WORD_RESERVE_BYTES,
} from "./voice-budget";
import {
	OpenWakeWordGgmlModel,
	WakeWordGgmlUnavailableError,
} from "./wake-word-ggml";

/** Directory holding the bundled openWakeWord GGUF inside a bundle. */
export const OPENWAKEWORD_DIR_REL_PATH = "wake";

/**
 * Combined wake-word GGUF: contains the mel filterbank constants, the
 * speech embedding model weights, AND every per-phrase classifier head
 * (`head.<name>.*` tensors). The fused `libelizainference` build mmaps
 * this file from `<bundleRoot>/wake/openwakeword.gguf` (or the shared
 * cache at `<state-dir>/local-inference/wake/openwakeword.gguf`).
 */
export const OPENWAKEWORD_GGUF_REL_PATH = path.join(
	OPENWAKEWORD_DIR_REL_PATH,
	"openwakeword.gguf",
);

/**
 * Default wake-phrase head shipped with a voice bundle. The documented
 * default Eliza-1 wake phrase is **"hey eliza"** — a two-word,
 * four-syllable phrase the openWakeWord TTS-augmented pipeline handles
 * well. It is replaceable: retrain on a different `--phrase` via
 * `packages/training/scripts/wakeword/train_eliza1_wakeword_head.py`,
 * convert to GGUF via
 * `packages/training/scripts/wakeword/convert_openwakeword_to_gguf.py`,
 * and re-point this constant.
 */
export const OPENWAKEWORD_DEFAULT_HEAD = "hey-eliza";

/**
 * Heads that are placeholders, not trained on the Eliza-1 wake phrase.
 *
 * `hey-eliza` stays in this set until a head trained against the real
 * phrase ships in every tier bundle (the bundled binary is still the
 * upstream `hey_jarvis_v0.1` weights renamed). `hey_jarvis` stays by
 * definition — it is the wrong phrase.
 *
 * A real "hey eliza" head HAS been trained and verified end-to-end through
 * this exact runtime — ~98% true-accept / ~4-7% false-accept on a held-out set
 * scored via `libwakeword.so` (see
 * `packages/training/scripts/wakeword/HEY_ELIZA_HEAD_PROVENANCE.md`). It must
 * be trained with `train_eliza1_wakeword_head.py --no-mel-rescale` to match
 * this runtime's mel preprocessing.
 *
 * The trained GGUFs are now PUBLISHED to `elizaos/eliza-1` at
 * `voice/wakeword/hey-eliza.{melspec,embedding,classifier}.gguf` and registered
 * in the voice catalog as `wakeword` v0.3.0 (`VOICE_MODEL_VERSIONS` in
 * `@elizaos/shared`). `hey-eliza` nonetheless STAYS in this set until that head
 * ships in every tier BUNDLE's `wake/` dir — the gated `publish_all_eliza1.sh`
 * re-publish — because the bundles users currently download still carry the
 * renamed `hey_jarvis` placeholder; removing the flag before the bundle ships
 * the real head would make the runtime treat the placeholder as authentic.
 * `hey_jarvis` stays by definition (wrong phrase). A future pass should make
 * this data-driven off the bundle manifest's `releaseState` rather than
 * hard-coded.
 */
export const OPENWAKEWORD_PLACEHOLDER_HEADS: ReadonlySet<string> = new Set([
	"hey-eliza",
	"hey_jarvis",
]);

export function isPlaceholderWakeWordHead(head: string): boolean {
	return OPENWAKEWORD_PLACEHOLDER_HEADS.has(head.trim());
}

/** Audio chunk the streaming pipeline consumes, in samples (80 ms @ 16 kHz). */
const FRAME_SAMPLES = 1280;

/**
 * Per-frame wake-word probability source. openWakeWord runs on 80 ms
 * frames of 16 kHz audio; `scoreFrame` takes one PCM frame and returns
 * the latest P(wake) in [0, 1] (the head only re-runs once enough
 * context has accumulated — early frames return 0). Stateful (the
 * streaming front-end carries its buffers); `reset()` clears it.
 *
 * The default backend (`GgmlWakeWordModel`) calls into the native FFI
 * synchronously; the method is still `async` so the interface fits a
 * async-friendly backend variant (e.g. worker-thread based) and
 * matches the same shape the previous ONNX backend exposed to callers.
 */
export type { WakeWordModel } from "./types.js";

import type { WakeWordModel } from "./types.js";

export interface WakeWordConfig {
	/** P(wake) above this fires a detection. openWakeWord default ~0.5. */
	threshold?: number;
	/**
	 * Consecutive frames at or above `threshold` required before a detection
	 * fires. The eliza-1 real-audio tier shows positives sustain for 10-17
	 * frames while hard negatives spike for at most 7, so the default 8-frame
	 * gate rejects transient false accepts without changing the model score.
	 */
	minActivationFrames?: number;
	/**
	 * Refractory frames after a detection during which no new detection
	 * fires (debounce a single utterance into one event).
	 */
	refractoryFrames?: number;
}

const DEFAULTS: Required<WakeWordConfig> = {
	threshold: 0.5,
	minActivationFrames: 8,
	refractoryFrames: 25, // ~2 s @ 80 ms frames
};

/**
 * Thrown when the native openWakeWord runtime cannot service this call:
 *   - `ffi-missing`: the FFI handle was not provided to the loader (the
 *     voice lifecycle hands one in via `loadBundledWakeWordModel`).
 *   - `runtime-not-ready`: the fused `libelizainference` build does not
 *     export `eliza_inference_wakeword_*` — the wake-word GGUF runtime
 *     is not yet compiled into this binary. NOT thrown for an absent
 *     bundled GGUF (that is "wake word unavailable for this bundle",
 *     not a broken build — `resolveWakeWordModel` returns null instead).
 *   - `model-load-failed`: the native side rejected the GGUF or the
 *     selected head name at session open.
 */
export class WakeWordUnavailableError extends Error {
	readonly code: "ffi-missing" | "runtime-not-ready" | "model-load-failed";
	constructor(code: WakeWordUnavailableError["code"], message: string) {
		super(message);
		this.name = "WakeWordUnavailableError";
		this.code = code;
	}
}

/** Path to the combined wake-word GGUF and the name of the head to bind. */
export interface WakeWordModelPaths {
	/** Absolute path to `wake/openwakeword.gguf`. */
	gguf: string;
	/** Name of the classifier head inside the GGUF (e.g. "hey-eliza"). */
	head: string;
}

/**
 * The real openWakeWord streaming detector, backed by the native FFI.
 * Owns one `eliza_inference_wakeword_*` session; `scoreFrame` consumes
 * exactly `frameSamples` (1280) samples at 16 kHz and returns the most
 * recent head probability the native pipeline produced. The audio tail,
 * mel ring and embedding ring live on the C side; this class is a thin
 * handle.
 */
export class GgmlWakeWordModel implements WakeWordModel {
	readonly frameSamples = FRAME_SAMPLES;
	readonly sampleRate = 16_000;
	private closed = false;

	private constructor(
		private readonly ffi: ElizaInferenceFfi,
		private readonly handle: NativeWakeWordHandle,
		/** Voice-budget reservation held while the native session is open. */
		private readonly reservation: BudgetReservation | null,
	) {}

	/**
	 * True only when the fused `libelizainference` build exports the
	 * wake-word ABI and advertises support at runtime. The wake-word
	 * loader uses this to surface a structured `runtime-not-ready` error
	 * before attempting to open a session.
	 */
	static isSupported(ffi: ElizaInferenceFfi | null | undefined): boolean {
		if (!ffi || typeof ffi.wakewordSupported !== "function") return false;
		return ffi.wakewordSupported();
	}

	/**
	 * Open a native wake-word session. Throws `WakeWordUnavailableError`
	 * when the runtime is not present or rejects the head name. No silent
	 * fallback (AGENTS.md §3).
	 */
	static async load(opts: {
		ffi: ElizaInferenceFfi;
		ctx: ElizaInferenceContextHandle | (() => ElizaInferenceContextHandle);
		headName: string;
		/** Voice-budget override; defaults to the process-wide shared budget. */
		budget?: VoiceBudget;
	}): Promise<GgmlWakeWordModel> {
		if (!GgmlWakeWordModel.isSupported(opts.ffi)) {
			throw new WakeWordUnavailableError(
				"runtime-not-ready",
				"[wake-word] The native wake-word GGUF runtime is not present in this libelizainference build. Rebuild with the openWakeWord GGML runtime linked in (eliza_inference_wakeword_* symbols).",
			);
		}
		if (
			!opts.ffi.wakewordOpen ||
			!opts.ffi.wakewordScore ||
			!opts.ffi.wakewordReset ||
			!opts.ffi.wakewordClose
		) {
			throw new WakeWordUnavailableError(
				"runtime-not-ready",
				"[wake-word] Wake-word support probe succeeded, but the required FFI methods are missing on the binding.",
			);
		}
		// Reserve before the native session opens; an over-budget arm throws
		// `VoiceLifecycleError("ram-pressure")` and nothing is loaded.
		const budget = opts.budget ?? (await ensureSharedVoiceBudget());
		const reservation = await reserveOrRamPressure(budget, {
			modelId: "openwakeword",
			role: "wake-word",
			bytes: WAKE_WORD_RESERVE_BYTES,
		});
		const ctx = typeof opts.ctx === "function" ? opts.ctx() : opts.ctx;
		let handle: NativeWakeWordHandle;
		try {
			handle = opts.ffi.wakewordOpen({
				ctx,
				sampleRateHz: 16_000,
				headName: opts.headName,
			});
		} catch (err) {
			reservation.release();
			throw new WakeWordUnavailableError(
				"model-load-failed",
				`[wake-word] failed to open native wake-word session for head '${opts.headName}': ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
		return new GgmlWakeWordModel(opts.ffi, handle, reservation);
	}

	async scoreFrame(frame: Float32Array): Promise<number> {
		if (this.closed) {
			throw new Error(
				"[wake-word] GgmlWakeWordModel.scoreFrame called after close()",
			);
		}
		if (frame.length !== FRAME_SAMPLES) {
			throw new Error(
				`[wake-word] GgmlWakeWordModel.scoreFrame expects ${FRAME_SAMPLES} samples; got ${frame.length}`,
			);
		}
		const score = this.ffi.wakewordScore;
		if (!score) {
			throw new Error("[wake-word] scoreFrame missing FFI method");
		}
		return score({ wake: this.handle, pcm: frame });
	}

	reset(): void {
		if (this.closed) return;
		const reset = this.ffi.wakewordReset;
		if (!reset) {
			throw new Error("[wake-word] reset missing FFI method");
		}
		reset(this.handle);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.ffi.wakewordClose?.(this.handle);
		this.reservation?.release();
	}
}

/**
 * Resolve the bundled wake-word GGUF. Unlike the VAD model this is
 * *optional* — a missing file means "wake word unavailable for this
 * bundle", not "broken bundle". Returns null when the GGUF is absent so
 * callers keep voice mode working (push-to-talk / VAD-gated) without it.
 *
 * Search order:
 *   1. `<bundleRoot>/wake/openwakeword.gguf`
 *   2. `<state-dir>/local-inference/wake/openwakeword.gguf` (shared cache)
 *
 * `head` defaults to the bundle's default wake phrase. The head name is
 * resolved by the native runtime against tensors inside the GGUF, so it
 * is validated at open time, not here.
 *
 * MUST only be called in `local` mode. The cloud-mode router does not
 * reach this (the wake-word setting is rejected there) — see AGENTS.md §5
 * hide-not-disable.
 */
export function resolveWakeWordModel(opts: {
	bundleRoot?: string;
	head?: string;
}): WakeWordModelPaths | null {
	const headName = opts.head?.trim() || OPENWAKEWORD_DEFAULT_HEAD;
	const candidates: string[] = [];
	if (opts.bundleRoot) {
		candidates.push(path.join(opts.bundleRoot, OPENWAKEWORD_GGUF_REL_PATH));
	}
	candidates.push(path.join(localInferenceRoot(), OPENWAKEWORD_GGUF_REL_PATH));
	for (const c of candidates) {
		if (existsSync(c)) return { gguf: path.resolve(c), head: headName };
	}
	return null;
}

/**
 * Resolve the standalone wakeword-cpp library + three-GGUF bundle.
 * Returns `null` when any of the four files is missing — that means
 * "use a different provider", not "broken bundle".
 *
 * Search order for the shared library:
 *   1. `$ELIZA_WAKEWORD_LIB` (operator override)
 *   2. `<bundleRoot>/wake/libwakeword.{so,dylib,dll}`
 *   3. `<state-dir>/local-inference/wake/libwakeword.{so,dylib,dll}`
 *   4. `packages/native/plugins/wakeword-cpp/build/libwakeword.{so,dylib,dll}`
 *      (developer build tree)
 *
 * Search order for the three GGUFs (per kind in
 * {melspec, embedding, classifier}):
 *   1. `<bundleRoot>/wake/<head>.<kind>.gguf`
 *   2. `<state-dir>/local-inference/wake/<head>.<kind>.gguf`
 *   3. `packages/native/plugins/wakeword-cpp/build/wakeword/<head>.<kind>.gguf`
 */
function libExtCandidates(): readonly string[] {
	switch (process.platform) {
		case "darwin":
			return [".dylib", ".so"] as const;
		case "win32":
			return [".dll"] as const;
		default:
			return [".so", ".dylib"] as const;
	}
}

function firstExisting(paths: readonly string[]): string | null {
	for (const p of paths) if (existsSync(p)) return path.resolve(p);
	return null;
}

/** Resolved triple of standalone wakeword-cpp paths (library + 3 GGUFs). */
export interface WakeWordStandalonePaths {
	libraryPath: string;
	melspec: string;
	embedding: string;
	classifier: string;
	head: string;
}

export function resolveWakeWordStandalonePaths(opts: {
	bundleRoot?: string;
	head?: string;
}): WakeWordStandalonePaths | null {
	const head = opts.head?.trim() || OPENWAKEWORD_DEFAULT_HEAD;
	const root = localInferenceRoot();

	const libCandidates: string[] = [];
	const envLib = process.env.ELIZA_WAKEWORD_LIB;
	if (envLib && envLib.length > 0) libCandidates.push(envLib);
	for (const ext of libExtCandidates()) {
		if (opts.bundleRoot)
			libCandidates.push(
				path.join(opts.bundleRoot, "wake", `libwakeword${ext}`),
			);
		libCandidates.push(path.join(root, "wake", `libwakeword${ext}`));
		libCandidates.push(
			path.join(
				__dirname,
				"..",
				"..",
				"..",
				"..",
				"..",
				"packages/native/plugins/wakeword-cpp/build",
				`libwakeword${ext}`,
			),
		);
	}
	const libraryPath = firstExisting(libCandidates);
	if (!libraryPath) return null;

	const ggufCandidates = (
		kind: "melspec" | "embedding" | "classifier",
	): string[] => {
		const fname = `${head}.${kind}.gguf`;
		const cs: string[] = [];
		if (opts.bundleRoot) cs.push(path.join(opts.bundleRoot, "wake", fname));
		cs.push(path.join(root, "wake", fname));
		cs.push(
			path.join(
				__dirname,
				"..",
				"..",
				"..",
				"..",
				"..",
				"packages/native/plugins/wakeword-cpp/build/wakeword",
				fname,
			),
		);
		return cs;
	};
	const melspec = firstExisting(ggufCandidates("melspec"));
	const embedding = firstExisting(ggufCandidates("embedding"));
	const classifier = firstExisting(ggufCandidates("classifier"));
	if (!melspec || !embedding || !classifier) return null;

	return { libraryPath, melspec, embedding, classifier, head };
}

/**
 * Open a wake-word session, preferring the fused `libelizainference`
 * wake-word path (the single native engine the whole voice pipeline runs
 * through — the user directive: no separate bun:ffi-musl libs). Falls back to
 * the standalone `wakeword-cpp` build only when the fused build does not carry
 * the wake-word GGUF. Returns `null` when neither provider can serve a session.
 *
 * Provider order:
 *   1. `GgmlWakeWordModel` (this file) — the fused-`libelizainference` path
 *      that consumes `wake/openwakeword.gguf` from the bundle cache via the
 *      `eliza_inference_wakeword_*` ABI. Tried first whenever the bundled GGUF
 *      is on disk; uses the same `ffi`/`ctx` as VAD / speaker / TTS / ASR.
 *   2. `OpenWakeWordGgmlModel` from `./wake-word-ggml.ts` — the standalone
 *      `packages/native/plugins/wakeword-cpp` build (three GGUFs). Guarded
 *      fallback for paths where the fused build lacks the wake-word runtime.
 *
 * `ffi` and `ctx` come from the voice lifecycle — they are the same
 * `ElizaInferenceFfi` handle and context the VAD / speaker / TTS / ASR paths
 * use. The standalone fallback uses neither.
 */
export async function loadBundledWakeWordModel(opts: {
	ffi: ElizaInferenceFfi;
	ctx: ElizaInferenceContextHandle | (() => ElizaInferenceContextHandle);
	bundleRoot?: string;
	head?: string;
}): Promise<WakeWordModel | null> {
	const paths = resolveWakeWordModel({
		...(opts.bundleRoot !== undefined ? { bundleRoot: opts.bundleRoot } : {}),
		...(opts.head !== undefined ? { head: opts.head } : {}),
	});
	if (paths && GgmlWakeWordModel.isSupported(opts.ffi)) {
		return GgmlWakeWordModel.load({
			ffi: opts.ffi,
			ctx: opts.ctx,
			headName: paths.head,
		});
	}

	// Fused build lacks the wake-word GGUF/runtime — fall back to the standalone
	// wakeword-cpp build when its library + three GGUFs are present.
	const standalone = resolveWakeWordStandalonePaths({
		...(opts.bundleRoot !== undefined ? { bundleRoot: opts.bundleRoot } : {}),
		...(opts.head !== undefined ? { head: opts.head } : {}),
	});
	if (standalone) {
		try {
			return await OpenWakeWordGgmlModel.load({
				libraryPath: standalone.libraryPath,
				paths: {
					melspec: standalone.melspec,
					embedding: standalone.embedding,
					classifier: standalone.classifier,
				},
			});
		} catch (err) {
			if (
				err instanceof WakeWordGgmlUnavailableError &&
				err.code === "not-bun"
			) {
				/* The standalone path needs Bun for `bun:ffi`; under Node
				 * we fall through to the fused path below. */
			} else {
				throw err;
			}
		}
	}

	// Last resort: the fused GGUF is present but the build did not advertise
	// support — let GgmlWakeWordModel.load surface the structured
	// runtime-not-ready error rather than silently returning null.
	if (!paths) return null;
	return GgmlWakeWordModel.load({
		ffi: opts.ffi,
		ctx: opts.ctx,
		headName: paths.head,
	});
}

/** Carried to `onWake` on each fresh detection. */
export interface WakeFireInfo {
	/** The classifier probability that crossed threshold, in [0, 1]. */
	confidence: number;
}

/**
 * Streaming wake-word detector. Feed frames; `onWake` fires once per
 * detected utterance (refractory-debounced) with the firing
 * {@link WakeFireInfo}. The voice loop wires `onWake` to "start a listening
 * window" — exactly what a push-to-talk press does — and to the fused-wake
 * bridge so the firing reaches the renderer as `eliza:fused-wake` (#10351).
 *
 * Only constructed in `local` mode. `cloud` mode never instantiates this
 * (and `resolveWakeWordModel` is never called there), so the surface is
 * inert per the hide-not-disable rule.
 */
export class OpenWakeWordDetector {
	private readonly model: WakeWordModel;
	private readonly cfg: Required<WakeWordConfig>;
	private cooldown = 0;
	private activationStreak = 0;
	private readonly onWake: (info: WakeFireInfo) => void;

	constructor(args: {
		model: WakeWordModel;
		config?: WakeWordConfig;
		onWake: (info: WakeFireInfo) => void;
	}) {
		this.model = args.model;
		const cfg = { ...DEFAULTS, ...(args.config ?? {}) };
		this.cfg = {
			...cfg,
			minActivationFrames: Math.max(1, Math.floor(cfg.minActivationFrames)),
		};
		this.onWake = args.onWake;
	}

	/**
	 * Score one PCM frame; fire `onWake` on a fresh detection. Resolves
	 * to true when this frame fired the wake word.
	 */
	async pushFrame(frame: Float32Array): Promise<boolean> {
		if (frame.length !== this.model.frameSamples) {
			throw new Error(
				`[wake-word] frame has ${frame.length} samples, expected ${this.model.frameSamples}`,
			);
		}
		if (this.cooldown > 0) {
			this.cooldown--;
			this.activationStreak = 0;
			await this.model.scoreFrame(frame); // keep the streaming state warm
			return false;
		}
		const p = await this.model.scoreFrame(frame);
		if (p >= this.cfg.threshold) {
			this.activationStreak++;
			if (this.activationStreak < this.cfg.minActivationFrames) {
				return false;
			}
			this.cooldown = this.cfg.refractoryFrames;
			this.activationStreak = 0;
			this.onWake({ confidence: p });
			return true;
		}
		this.activationStreak = 0;
		return false;
	}

	reset(): void {
		this.model.reset();
		this.cooldown = 0;
		this.activationStreak = 0;
	}
}
