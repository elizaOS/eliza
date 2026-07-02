/**
 * Kokoro-82M model runner.
 *
 * Execution paths:
 *
 *   1. GGUF via llama-server (default). When the host llama-server advertises
 *      a Kokoro-capable build and exposes `/v1/audio/speech`, we POST text in
 *      and stream PCM out.
 *
 *   2. Python subprocess — eval-loop only. Spawns `python -m kokoro_tts`.
 *      Never the default in production.
 */

import type { KokoroPhonemeSequence, KokoroVoicePack } from "./types";

/** Pinned GGUF candidate location (carried by our llama.cpp fork). The
 *  runtime references this only for diagnostics; the fork-side builder
 *  produces the file at this path. */
export const KOKORO_GGUF_REL_PATH = "voice/kokoro-82m-v1_0.gguf";

/** One synthesized PCM segment delivered to the streaming backend. */
export interface KokoroRuntimeChunk {
	pcm: Float32Array;
	sampleRate: number;
	isFinal: boolean;
}

/**
 * Construction-time inputs for a runtime instance. The voice pack contains
 * the style tensor reference; the runtime is responsible for resolving the
 * bytes off `layout.voicesDir/<file>`.
 */
export interface KokoroRuntimeInputs {
	/**
	 * Raw (pre-phonemization) phrase text. The in-process fused engine
	 * (`KokoroFfiRuntime`) MUST synthesize from this: `eliza_inference_kokoro_synthesize`
	 * phonemizes internally (espeak-ng when linked, ASCII grapheme fallback
	 * otherwise). Feeding it the JS-side IPA string double-phonemizes — the
	 * engine's per-byte ASCII fallback shreds multi-byte IPA codepoints and the
	 * espeak path re-G2Ps IPA as if it were words; both produce speech-shaped
	 * but lexically wrong audio (#10726).
	 */
	text: string;
	phonemes: KokoroPhonemeSequence;
	voice: KokoroVoicePack;
	/**
	 * Output sample budget. The runtime always honours the model's native
	 * sample rate (`layout.sampleRate`, usually 24 kHz) — this caps the
	 * total samples to prevent runaway generation. Defaults to 16 seconds
	 * at the layout sample rate (matches the longest phrase the chunker
	 * will emit + headroom).
	 */
	maxSamples?: number;
	/** Cancellation signal — polled at chunk boundaries. */
	cancelSignal: { cancelled: boolean };
	/** Per-chunk callback; returning `true` cancels the rest of the run. */
	onChunk: (chunk: KokoroRuntimeChunk) => boolean | undefined;
}

/** Shared runtime contract — `KokoroTtsBackend` depends on this, not the
 *  concrete classes. Tests inject a mock. */
export interface KokoroRuntime {
	readonly id: "gguf" | "python" | "mock";
	readonly sampleRate: number;
	synthesize(args: KokoroRuntimeInputs): Promise<{ cancelled: boolean }>;
	dispose(): void;
}

// ---------------------------------------------------------------------------
// Python subprocess path — eval-loop only.
// ---------------------------------------------------------------------------

export interface KokoroPythonRuntimeOptions {
	pythonBinary: string;
	/** Resolved layout — the subprocess discovers the model under here. */
	layout: { root: string; sampleRate: number };
	/** Optional env passed through to the subprocess. */
	env?: NodeJS.ProcessEnv;
}

/**
 * Subprocess-backed runtime. Spawns `python -m kokoro_tts ...` per
 * synthesis call (no warm-pool — the Python path is the *eval* path, not
 * the realtime path). Production code paths never select this; the
 * fine-tune evaluator wires it explicitly.
 */
export class KokoroPythonRuntime implements KokoroRuntime {
	readonly id = "python" as const;
	readonly sampleRate: number;

	constructor(opts: KokoroPythonRuntimeOptions) {
		this.sampleRate = opts.layout.sampleRate;
	}

	async synthesize(
		_args: KokoroRuntimeInputs,
	): Promise<{ cancelled: boolean }> {
		// The eval driver in `packages/training` is the canonical caller and
		// already wires `child_process.spawn`. Surfacing a clear error here
		// keeps the production runtime from accidentally enabling this path.
		throw new Error(
			"[kokoro] KokoroPythonRuntime is eval-only — use it from the fine-tune driver, not the runtime scheduler",
		);
	}

	dispose(): void {
		// No long-lived state.
	}
}

// ---------------------------------------------------------------------------
// Mock runtime — synthesizes a sine sweep keyed to phoneme count so tests
// can observe deterministic PCM without loading a model.
// ---------------------------------------------------------------------------

export interface KokoroMockRuntimeOptions {
	sampleRate: number;
	/** Total samples emitted per synthesis call. */
	totalSamples?: number;
	/** Number of body chunks to split the output across. */
	chunkCount?: number;
}

export class KokoroMockRuntime implements KokoroRuntime {
	readonly id = "mock" as const;
	readonly sampleRate: number;
	private readonly opts: Required<KokoroMockRuntimeOptions>;
	calls = 0;

	constructor(opts: KokoroMockRuntimeOptions) {
		this.sampleRate = opts.sampleRate;
		this.opts = {
			sampleRate: opts.sampleRate,
			totalSamples: opts.totalSamples ?? Math.floor(opts.sampleRate * 0.2),
			chunkCount: opts.chunkCount ?? 4,
		};
	}

	async synthesize(args: KokoroRuntimeInputs): Promise<{ cancelled: boolean }> {
		this.calls++;
		const { totalSamples, chunkCount } = this.opts;
		const perChunk = Math.max(1, Math.ceil(totalSamples / chunkCount));
		const freqHz = 100 + (args.phonemes.ids.length % 200);
		let written = 0;
		let cancelled = false;
		for (let off = 0; off < totalSamples; off += perChunk) {
			if (args.cancelSignal.cancelled) {
				cancelled = true;
				break;
			}
			const n = Math.min(perChunk, totalSamples - off);
			const pcm = new Float32Array(n);
			for (let i = 0; i < n; i++) {
				const t = (off + i) / this.sampleRate;
				pcm[i] = Math.sin(2 * Math.PI * freqHz * t) * 0.1;
			}
			written += n;
			const want = args.onChunk({
				pcm,
				sampleRate: this.sampleRate,
				isFinal: false,
			});
			if (want === true || args.cancelSignal.cancelled) {
				cancelled = true;
				break;
			}
		}
		args.onChunk({
			pcm: new Float32Array(0),
			sampleRate: this.sampleRate,
			isFinal: true,
		});
		void written;
		return { cancelled };
	}

	dispose(): void {
		/* nothing */
	}
}
