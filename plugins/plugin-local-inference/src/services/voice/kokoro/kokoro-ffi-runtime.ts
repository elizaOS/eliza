/**
 * In-process Kokoro-82M runtime over the fused `libelizainference` FFI
 * (the `eliza_inference_kokoro_*` exports — introduced at ABI v10; ABI v14 adds
 * the IPA-input entry + G2P-kind query — see `ELIZA_INFERENCE_ABI_VERSION` in
 * ffi-bindings.ts).
 *
 * G2P routing (#11776): the fused build only links libespeak-ng on some hosts
 * and never on Android/iOS. Where it does (`kokoroG2pKind() === "espeak"`) the
 * lib phonemizes raw text itself and synthesis sends the raw phrase (#11238 —
 * sending IPA there would double-phonemize). Where it does NOT
 * (`"ascii"`) the lib's raw-text path is a lossy grapheme fallback that yields
 * unintelligible audio, so synthesis instead feeds the espeak-ng IPA the TS
 * phonemizer already produced through `synthesize_ipa`. A pre-v14 lib
 * (`"unknown"`) keeps raw text with a one-time warning.
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

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { resolveFusedLibraryPath } from "../../desktop-fused-ffi-backend-runtime";
import {
	type ElizaInferenceContextHandle,
	type ElizaInferenceFfi,
	loadElizaInferenceFfi,
} from "../ffi-bindings";
import { VoiceLifecycleError } from "../lifecycle";
import {
	readVoicePresetFile,
	VOICE_PRESET_MAGIC,
	VoicePresetFormatError,
} from "../voice-preset-format";
import type { KokoroRuntime, KokoroRuntimeInputs } from "./kokoro-runtime";
import type { KokoroModelLayout } from "./types";
import { resolveKokoroVoiceOrDefault } from "./voices";

/** Kokoro v1.0 style-vector inner dimension. */
const KOKORO_STYLE_DIM = 256;
const GGUF_MAGIC = 0x4655_4747; // 'GGUF' little-endian
const GGUF_DEFAULT_ALIGNMENT = 32;
const GGUF_TYPE_UINT32 = 4;
const GGUF_TYPE_FLOAT32 = 6;
const GGUF_TYPE_BOOL = 7;
const GGUF_TYPE_STRING = 8;
const GGML_TYPE_F32 = 0;

/**
 * Per-synthesis output ceiling. Kokoro v1.0 emits 24 kHz fp32 PCM; 30 s of
 * headroom (720 000 samples) bounds a single phrase synthesis well past the
 * longest chunk the phrase chunker will hand us. The library returns the real
 * sample count, which we slice to — this is only the allocation cap.
 */
const MAX_OUTPUT_SAMPLES = 30 * 24_000;

function isPackagedVoicePreset(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 4) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return view.getUint32(0, true) === VOICE_PRESET_MAGIC;
}

function isGgufVoicePreset(bytes: Uint8Array): boolean {
	if (bytes.byteLength < 4) return false;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return view.getUint32(0, true) === GGUF_MAGIC;
}

function writeRawVoiceBytes(
	voiceId: string,
	styleDim: number,
	raw: Uint8Array,
): string {
	const digest = createHash("sha256").update(raw).digest("hex").slice(0, 16);
	const dir = path.join(os.tmpdir(), "eliza-kokoro-voices");
	mkdirSync(dir, { recursive: true });

	const out = path.join(dir, `${voiceId}-${styleDim}-${digest}.bin`);
	try {
		writeFileSync(out, raw, { flag: "wx" });
	} catch (err) {
		const code =
			typeof err === "object" && err !== null && "code" in err
				? String((err as { code?: unknown }).code)
				: "";
		if (code !== "EEXIST") throw err;
	}
	return out;
}

function writeRawVoiceTensor(
	voiceId: string,
	styleDim: number,
	embedding: Float32Array,
): string {
	return writeRawVoiceBytes(
		voiceId,
		styleDim,
		new Uint8Array(
			embedding.buffer,
			embedding.byteOffset,
			embedding.byteLength,
		),
	);
}

function checkedU64ToNumber(value: bigint, label: string): number {
	if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[KokoroFfiRuntime] GGUF ${label} exceeds JavaScript safe integer range`,
		);
	}
	return Number(value);
}

function readGgufU32(
	view: DataView,
	pos: number,
	label: string,
): [number, number] {
	if (pos + 4 > view.byteLength) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[KokoroFfiRuntime] truncated GGUF while reading ${label}`,
		);
	}
	return [view.getUint32(pos, true), pos + 4];
}

function readGgufU64(
	view: DataView,
	pos: number,
	label: string,
): [number, number] {
	if (pos + 8 > view.byteLength) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[KokoroFfiRuntime] truncated GGUF while reading ${label}`,
		);
	}
	return [checkedU64ToNumber(view.getBigUint64(pos, true), label), pos + 8];
}

function readGgufString(
	view: DataView,
	bytes: Uint8Array,
	pos: number,
	label: string,
): [string, number] {
	let len: number;
	[len, pos] = readGgufU64(view, pos, `${label} length`);
	if (pos + len > bytes.byteLength) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[KokoroFfiRuntime] truncated GGUF while reading ${label}`,
		);
	}
	return [new TextDecoder().decode(bytes.subarray(pos, pos + len)), pos + len];
}

function readGgufValue(
	view: DataView,
	bytes: Uint8Array,
	pos: number,
	type: number,
	label: string,
): [unknown, number] {
	switch (type) {
		case GGUF_TYPE_UINT32:
			return readGgufU32(view, pos, label);
		case GGUF_TYPE_FLOAT32:
			if (pos + 4 > view.byteLength) {
				throw new VoiceLifecycleError(
					"kernel-missing",
					`[KokoroFfiRuntime] truncated GGUF while reading ${label}`,
				);
			}
			return [view.getFloat32(pos, true), pos + 4];
		case GGUF_TYPE_BOOL:
			if (pos + 1 > view.byteLength) {
				throw new VoiceLifecycleError(
					"kernel-missing",
					`[KokoroFfiRuntime] truncated GGUF while reading ${label}`,
				);
			}
			return [view.getUint8(pos) !== 0, pos + 1];
		case GGUF_TYPE_STRING:
			return readGgufString(view, bytes, pos, label);
		default:
			throw new VoiceLifecycleError(
				"kernel-missing",
				`[KokoroFfiRuntime] unsupported GGUF metadata type ${type} for ${label}`,
			);
	}
}

function alignGgufOffset(pos: number, alignment: number): number {
	return Math.ceil(pos / alignment) * alignment;
}

function extractGgufVoiceTensor(
	voiceBinPath: string,
	bytes: Uint8Array,
	styleDim: number,
): Uint8Array {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	let pos = 0;
	const [magic, afterMagic] = readGgufU32(view, pos, "magic");
	pos = afterMagic;
	if (magic !== GGUF_MAGIC) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[KokoroFfiRuntime] ${voiceBinPath} is not a GGUF voice preset`,
		);
	}

	let version: number;
	let tensorCount: number;
	let metadataCount: number;
	[version, pos] = readGgufU32(view, pos, "version");
	[tensorCount, pos] = readGgufU64(view, pos, "tensor count");
	[metadataCount, pos] = readGgufU64(view, pos, "metadata count");
	if (version !== 3) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[KokoroFfiRuntime] unsupported GGUF voice preset version ${version} at ${voiceBinPath}`,
		);
	}

	let alignment = GGUF_DEFAULT_ALIGNMENT;
	let metadataStyleDim: number | null = null;
	for (let i = 0; i < metadataCount; i++) {
		let key: string;
		let type: number;
		[key, pos] = readGgufString(view, bytes, pos, `metadata key #${i}`);
		[type, pos] = readGgufU32(view, pos, `metadata type ${key}`);
		let value: unknown;
		[value, pos] = readGgufValue(view, bytes, pos, type, `metadata ${key}`);
		if (key === "general.alignment" && typeof value === "number") {
			// Must be a positive integer: `alignGgufOffset` divides by it, so 0
			// yields NaN offsets that slip past the bounds checks (NaN comparisons
			// are false) and silently materialize an empty voice. Fail loud.
			if (!Number.isInteger(value) || value <= 0) {
				throw new VoiceLifecycleError(
					"kernel-missing",
					`[KokoroFfiRuntime] GGUF voice preset at ${voiceBinPath} has invalid general.alignment ${value}`,
				);
			}
			alignment = value;
		}
		if (key === "kokoro_voice.style_dim" && typeof value === "number") {
			metadataStyleDim = value;
		}
	}
	if (metadataStyleDim !== null && metadataStyleDim !== styleDim) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[KokoroFfiRuntime] GGUF voice preset at ${voiceBinPath} has style_dim ${metadataStyleDim}; expected ${styleDim}`,
		);
	}

	let selected: {
		readonly name: string;
		readonly dims: number[];
		readonly type: number;
		readonly offset: number;
	} | null = null;
	for (let i = 0; i < tensorCount; i++) {
		let name: string;
		let nDims: number;
		[name, pos] = readGgufString(view, bytes, pos, `tensor name #${i}`);
		[nDims, pos] = readGgufU32(view, pos, `tensor ${name} rank`);
		const dims: number[] = [];
		for (let d = 0; d < nDims; d++) {
			let dim: number;
			[dim, pos] = readGgufU64(view, pos, `tensor ${name} dim #${d}`);
			dims.push(dim);
		}
		let type: number;
		let offset: number;
		[type, pos] = readGgufU32(view, pos, `tensor ${name} type`);
		[offset, pos] = readGgufU64(view, pos, `tensor ${name} offset`);
		if (name === "voice.pack" || (selected === null && tensorCount === 1)) {
			selected = { name, dims, type, offset };
		}
	}

	if (!selected) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[KokoroFfiRuntime] GGUF voice preset at ${voiceBinPath} does not contain voice.pack`,
		);
	}
	if (selected.type !== GGML_TYPE_F32) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[KokoroFfiRuntime] GGUF voice tensor ${selected.name} at ${voiceBinPath} is type ${selected.type}; expected F32`,
		);
	}

	const elementCount = selected.dims.reduce((acc, dim) => acc * dim, 1);
	const byteLength = elementCount * 4;
	const dataStart = alignGgufOffset(pos, alignment);
	const tensorStart = dataStart + selected.offset;
	const tensorEnd = tensorStart + byteLength;
	if (tensorStart < dataStart || tensorEnd > bytes.byteLength) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[KokoroFfiRuntime] GGUF voice tensor ${selected.name} at ${voiceBinPath} overruns file bounds`,
		);
	}
	if (byteLength === 0 || byteLength % (styleDim * 4) !== 0) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[KokoroFfiRuntime] GGUF voice tensor ${selected.name} at ${voiceBinPath} has ${byteLength} bytes; expected a positive multiple of ${styleDim * 4}`,
		);
	}

	const raw = new Uint8Array(byteLength);
	raw.set(bytes.subarray(tensorStart, tensorEnd));
	return raw;
}

function resolveVoiceBinPathForFfi(
	voiceBinPath: string,
	voice: { id: string; dim?: number },
): string {
	const bytes = readFileSync(voiceBinPath);
	if (isGgufVoicePreset(bytes)) {
		const styleDim = voice.dim ?? KOKORO_STYLE_DIM;
		return writeRawVoiceBytes(
			voice.id,
			styleDim,
			extractGgufVoiceTensor(voiceBinPath, bytes, styleDim),
		);
	}
	if (!isPackagedVoicePreset(bytes)) return voiceBinPath;

	let preset: ReturnType<typeof readVoicePresetFile>;
	try {
		preset = readVoicePresetFile(bytes);
	} catch (err) {
		if (err instanceof VoicePresetFormatError) {
			throw new VoiceLifecycleError(
				"kernel-missing",
				`[KokoroFfiRuntime] packaged voice preset at ${voiceBinPath} is malformed: ${err.message}`,
			);
		}
		throw err;
	}

	const styleDim = voice.dim ?? KOKORO_STYLE_DIM;
	if (preset.embedding.length !== styleDim) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[KokoroFfiRuntime] packaged voice preset at ${voiceBinPath} has ${preset.embedding.length} style values; expected ${styleDim} for voice ${voice.id}`,
		);
	}

	return writeRawVoiceTensor(voice.id, styleDim, preset.embedding);
}

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
	/**
	 * Which G2P path the loaded fused lib uses (queried once at construction).
	 * Decides whether synthesis sends raw text (`espeak` — the lib phonemizes)
	 * or precomputed espeak-ng IPA (`ascii` — the lib's raw-text path is the
	 * lossy grapheme fallback). `unknown` = a pre-v14 lib without the IPA
	 * symbols; the runtime keeps raw text and warns once (#11776).
	 */
	private readonly g2pKind: "espeak" | "ascii" | "unknown";
	/** One-time warning latches (avoid log spam on every phrase). */
	private warnedOldLib = false;
	private warnedFallbackPhonemizer = false;
	private warnedEmptyIpa = false;

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

		// Query the lib's G2P kind once. On an espeak-less build (`ascii`) the
		// native raw-text path is unintelligible, so synthesis routes through the
		// IPA entry with the TS phonemizer's espeak-ng IPA (#11776). A pre-v14 lib
		// lacks the query symbol → `unknown` → keep raw text (warned once).
		this.g2pKind =
			typeof this.ffi.kokoroG2pKind === "function"
				? this.ffi.kokoroG2pKind(this.ctx)
				: "unknown";

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
		const pcm = this.synthesizePcm(args, maxSamples);

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
		const ffiVoiceBinPath = resolveVoiceBinPathForFfi(voiceBinPath, voice);
		this.ffi.kokoroLoad({
			ctx: this.ctx,
			ggufPath,
			voiceBinPath: ffiVoiceBinPath,
			styleDim: voice.dim ?? KOKORO_STYLE_DIM,
		});
		this.loadedVoiceId = voice.id;
		logger.info(
			`[KokoroFfiRuntime] loaded Eliza-1 voice ${voice.id} from ${voiceBinPath}`,
		);
	}

	/**
	 * Route one phrase to the correct native entry based on the loaded lib's
	 * G2P kind:
	 *   - `espeak`: the lib phonemizes raw text with real espeak-ng → send text
	 *     (the #11238 behavior; sending IPA here would double-phonemize).
	 *   - `ascii`: the lib's raw-text path is the lossy grapheme fallback
	 *     (unintelligible) → send the espeak-ng IPA the TS phonemizer produced
	 *     through the native IPA entry (#11776).
	 *   - `unknown`: a pre-v14 lib without the IPA entry → keep raw text and warn
	 *     once (correct on espeak-linked builds, garbled on espeak-less ones).
	 */
	private synthesizePcm(
		args: KokoroRuntimeInputs,
		maxSamples: number,
	): Float32Array {
		if (this.g2pKind === "ascii") {
			const ipa = args.phonemes.phonemes;
			if (ipa.length > 0) {
				if (
					args.phonemizerId === "fallback-g2p" &&
					!this.warnedFallbackPhonemizer
				) {
					this.warnedFallbackPhonemizer = true;
					logger.warn(
						"[KokoroFfiRuntime] the loaded Kokoro lib has no espeak-ng (g2p=ascii) and the " +
							"TS phonemizer resolved to the lossy 'fallback-g2p' — audio will be degraded. " +
							"Install the 'phonemizer' npm package (espeak-ng WASM) for intelligible speech (#11776).",
					);
				}
				return this.kokoroSynthesizeIpa(ipa, maxSamples);
			}
			if (!this.warnedEmptyIpa) {
				this.warnedEmptyIpa = true;
				logger.warn(
					"[KokoroFfiRuntime] g2p=ascii but the phrase produced no IPA — falling back to raw " +
						"text (the lib's lossy ASCII grapheme path). Check the TS phonemizer chain (#11776).",
				);
			}
			return this.kokoroSynthesize(args.text, maxSamples);
		}

		if (this.g2pKind === "unknown" && !this.warnedOldLib) {
			this.warnedOldLib = true;
			logger.warn(
				"[KokoroFfiRuntime] the loaded libelizainference predates the Kokoro IPA G2P surface " +
					`(ABI v14, #11776; lib reports ABI v${this.ffi.libraryAbiVersion}). Using raw-text ` +
					"synthesis — correct on an espeak-linked build, but UNINTELLIGIBLE on an espeak-less " +
					"one. Rebuild the fused lib to pick up the IPA path.",
			);
		}
		return this.kokoroSynthesize(args.text, maxSamples);
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

	private kokoroSynthesizeIpa(ipa: string, maxSamples: number): Float32Array {
		if (typeof this.ffi.kokoroSynthesizeIpa !== "function") {
			// g2pKind === "ascii" is only reachable when the v14 symbols bound, so
			// this is an invariant breach rather than an old-lib case.
			throw new VoiceLifecycleError(
				"kernel-missing",
				"[KokoroFfiRuntime] eliza_inference_kokoro_synthesize_ipa is not exported despite g2p=ascii",
			);
		}
		return this.ffi.kokoroSynthesizeIpa({ ctx: this.ctx, ipa, maxSamples });
	}
}
