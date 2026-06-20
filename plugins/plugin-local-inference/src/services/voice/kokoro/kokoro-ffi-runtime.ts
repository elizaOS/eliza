/**
 * In-process Kokoro-82M runtime over the fused `libelizainference` FFI
 * (the `eliza_inference_kokoro_*` exports — introduced at ABI v10; the fused
 * library is currently ABI v11, which adds EOT on top, so these symbols are
 * present in every current build — see `ELIZA_INFERENCE_ABI_VERSION` in
 * ffi-bindings.ts).
 *
 * This is the canonical Kokoro execution path on every platform. It replaces
 * the local-TCP `KokoroGgufRuntime` (POST `/v1/audio/speech` on a running
 * llama-server) for the mobile case — iOS and Google Play forbid the app
 * opening a local TCP socket, so the HTTP→llama-server route cannot ship there.
 * Kokoro synthesizes through the same dlopen()-ed handle as OmniVoice: the
 * fused build links Eliza-1's Kokoro engine (its own GGUF reader + iSTFT
 * decoder) behind `eliza_inference_kokoro_supported/load/synthesize/sample_rate`.
 *
 * Ownership: this runtime owns its own FFI handle + context. The context is
 * created with `create(bundleRoot)` anchored at the bundle root (or the Kokoro
 * model root when there is no Eliza-1 bundle), mirroring how the desktop fused
 * text runtime obtains its ctx. The GGUF + the active voice `.bin` are loaded
 * once via `kokoroLoad` and reloaded only when the requested voice changes.
 *
 * No silent fallback (AGENTS.md §3): when the loaded library does not export
 * the Kokoro symbols (`kokoroSupported() === false`) or the model/voice files
 * are missing, construction / first synthesis throws a structured
 * `VoiceLifecycleError` rather than dropping back to the TCP route.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "@elizaos/core";
import { resolveFusedLibraryPath } from "../../desktop-fused-ffi-backend-runtime";
import {
	type ElizaInferenceContextHandle,
	type ElizaInferenceFfi,
	loadElizaInferenceFfi,
} from "../ffi-bindings";
import { VoiceLifecycleError } from "../lifecycle";
import type { KokoroRuntime, KokoroRuntimeInputs } from "./kokoro-runtime";
import type { KokoroModelLayout } from "./types";
import { resolveKokoroVoiceOrDefault } from "./voices";

/** Kokoro v1.0 style-vector inner dimension. */
const KOKORO_STYLE_DIM = 256;

/**
 * Per-synthesis output ceiling. Kokoro v1.0 emits 24 kHz fp32 PCM; 30 s of
 * headroom (720 000 samples) bounds a single phrase synthesis well past the
 * longest chunk the phrase chunker will hand us. The library returns the real
 * sample count, which we slice to — this is only the allocation cap.
 */
const MAX_OUTPUT_SAMPLES = 30 * 24_000;

export interface KokoroFfiRuntimeOptions {
	/** Resolved on-disk Kokoro layout (GGUF filename + voices dir + root). */
	layout: KokoroModelLayout;
	/**
	 * Directory the FFI context anchors at (`create(bundleRoot)`). Defaults to
	 * the Kokoro model root, which is sufficient for the standalone Kokoro
	 * engine — it loads the GGUF + voice `.bin` by explicit absolute path, not
	 * by bundle convention.
	 */
	bundleRoot?: string;
	/**
	 * Inject a pre-loaded FFI handle (the desktop fused engine already owns one).
	 * When omitted the runtime loads its own via `resolveFusedLibraryPath`.
	 */
	ffi?: ElizaInferenceFfi;
	/**
	 * Inject a context to reuse. When omitted the runtime creates its own with
	 * `ffi.create(bundleRoot)` and destroys it on `dispose`.
	 */
	ctx?: ElizaInferenceContextHandle;
}

export class KokoroFfiRuntime implements KokoroRuntime {
	readonly id = "gguf" as const;
	readonly sampleRate: number;

	private readonly layout: KokoroModelLayout;
	private readonly ffi: ElizaInferenceFfi;
	private readonly ownsFfi: boolean;
	private readonly ctx: ElizaInferenceContextHandle;
	private readonly ownsCtx: boolean;
	/** Voice id currently resident on the ctx (null until first load). */
	private loadedVoiceId: string | null = null;
	private disposed = false;

	constructor(opts: KokoroFfiRuntimeOptions) {
		this.layout = opts.layout;
		const bundleRoot = opts.bundleRoot ?? opts.layout.root;

		const provided = opts.ffi;
		if (provided) {
			this.ffi = provided;
			this.ownsFfi = false;
		} else {
			const libPath = resolveFusedLibraryPath(bundleRoot);
			if (!libPath) {
				throw new VoiceLifecycleError(
					"kernel-missing",
					`[KokoroFfiRuntime] fused libelizainference not found for the in-process Eliza-1 Kokoro engine (anchored at ${bundleRoot}). ` +
						"Set ELIZA_INFERENCE_LIBRARY or build via packages/app-core/scripts/build-llama-cpp-mtp.mjs.",
				);
			}
			this.ffi = loadElizaInferenceFfi(libPath);
			this.ownsFfi = true;
		}

		if (
			typeof this.ffi.kokoroSupported !== "function" ||
			!this.ffi.kokoroSupported()
		) {
			if (this.ownsFfi) this.ffi.close();
			throw new VoiceLifecycleError(
				"kernel-missing",
				`[KokoroFfiRuntime] the loaded libelizainference (ABI v${this.ffi.libraryAbiVersion}) does not link the in-process Eliza-1 Kokoro engine. ` +
					"Rebuild with the Kokoro engine enabled — the mobile path must not fall back to the local-TCP /v1/audio/speech route.",
			);
		}

		if (opts.ctx !== undefined) {
			this.ctx = opts.ctx;
			this.ownsCtx = false;
		} else {
			this.ctx = this.ffi.create(bundleRoot);
			this.ownsCtx = true;
		}

		this.sampleRate = this.layout.sampleRate;
	}

	async synthesize(args: KokoroRuntimeInputs): Promise<{ cancelled: boolean }> {
		if (this.disposed) {
			throw new VoiceLifecycleError(
				"kernel-missing",
				"[KokoroFfiRuntime] synthesize called after dispose",
			);
		}
		this.ensureVoiceLoaded(args.voice.id);

		if (args.cancelSignal.cancelled) {
			args.onChunk({
				pcm: new Float32Array(0),
				sampleRate: this.sampleRate,
				isFinal: true,
			});
			return { cancelled: true };
		}

		const maxSamples = args.maxSamples ?? MAX_OUTPUT_SAMPLES;
		// The Kokoro engine produces the full waveform in one synchronous
		// forward. The text it phonemizes internally is the same phoneme string
		// the llama-server `/v1/audio/speech` path sends as `input`.
		const pcm = this.kokoroSynthesize(args.phonemes.phonemes, maxSamples);

		let cancelled = false;
		if (args.cancelSignal.cancelled) {
			cancelled = true;
		} else if (pcm.length > 0) {
			const want = args.onChunk({
				pcm,
				sampleRate: this.sampleRate,
				isFinal: false,
			});
			if (want === true || args.cancelSignal.cancelled) cancelled = true;
		}

		args.onChunk({
			pcm: new Float32Array(0),
			sampleRate: this.sampleRate,
			isFinal: true,
		});
		return { cancelled };
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.ownsCtx) this.ffi.destroy(this.ctx);
		if (this.ownsFfi) this.ffi.close();
	}

	/**
	 * Load the GGUF + the requested voice `.bin` into the ctx, reloading only
	 * when the voice changes (Kokoro keeps the model resident; swapping voices
	 * is a cheap re-load of the 256-float style tensor).
	 */
	private ensureVoiceLoaded(requestedVoiceId: string): void {
		const voice = resolveKokoroVoiceOrDefault(requestedVoiceId);
		if (this.loadedVoiceId === voice.id) return;

		const ggufPath = path.join(this.layout.root, this.layout.modelFile);
		const voiceBinPath = path.join(this.layout.voicesDir, voice.file);
		if (!existsSync(ggufPath)) {
			throw new VoiceLifecycleError(
				"kernel-missing",
				`[KokoroFfiRuntime] Eliza-1 Kokoro model file not found at ${ggufPath}`,
			);
		}
		if (!existsSync(voiceBinPath)) {
			throw new VoiceLifecycleError(
				"kernel-missing",
				`[KokoroFfiRuntime] Eliza-1 voice preset not found at ${voiceBinPath} for voice ${voice.id}`,
			);
		}
		if (typeof this.ffi.kokoroLoad !== "function") {
			throw new VoiceLifecycleError(
				"kernel-missing",
				"[KokoroFfiRuntime] eliza_inference_kokoro_load is not exported by the loaded build",
			);
		}
		this.ffi.kokoroLoad({
			ctx: this.ctx,
			ggufPath,
			voiceBinPath,
			styleDim: voice.dim ?? KOKORO_STYLE_DIM,
		});
		this.loadedVoiceId = voice.id;
		logger.info(
			`[KokoroFfiRuntime] loaded Eliza-1 voice ${voice.id} from ${voiceBinPath}`,
		);
	}

	private kokoroSynthesize(text: string, maxSamples: number): Float32Array {
		if (typeof this.ffi.kokoroSynthesize !== "function") {
			throw new VoiceLifecycleError(
				"kernel-missing",
				"[KokoroFfiRuntime] eliza_inference_kokoro_synthesize is not exported by the loaded build",
			);
		}
		return this.ffi.kokoroSynthesize({ ctx: this.ctx, text, maxSamples });
	}
}
