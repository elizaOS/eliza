/**
 * Node/Bun FFI binding to `libelizainference.{dylib,so,dll}`.
 *
 * The fused omnivoice + llama.cpp build (see
 * `packages/app-core/scripts/omnivoice-fuse/`) produces ONE shared
 * library that exports both `llama_*` and `omnivoice_*` symbols plus
 * the C ABI declared in `scripts/omnivoice-fuse/ffi.h`. This module is
 * the JS-side proxy for that ABI — it loads the library, binds every
 * `eliza_inference_*` symbol declared in `ffi.h`, and exposes a typed
 * handle (`ElizaInferenceFfi`) the voice lifecycle calls into.
 *
 * Runtime: production runs under Bun (Electrobun shell, Capacitor
 * bridge), so the loader uses `bun:ffi`. Tests that need to actually
 * load a `.dylib` against a stub library spawn a `bun` subprocess —
 * see `ffi-bindings.test.ts`. Calling this loader from a non-Bun
 * runtime (e.g. plain Node) throws `VoiceLifecycleError({code:
 * "missing-ffi"})` with a diagnostic explaining why.
 *
 * No defensive try/catch on the success path. Any dlopen failure,
 * symbol-resolution failure, or ABI mismatch is a structured throw
 * (AGENTS.md §3 + §9). The caller — `voice/lifecycle.ts` and
 * `voice/engine-bridge.ts` — surfaces it as a `VoiceLifecycleError` to
 * the UI.
 */
import { VoiceLifecycleError } from "./lifecycle";
/**
 * ABI version the JS binding was authored against. Must match the value
 * `eliza_inference_abi_version()` returns at runtime — a mismatch is a
 * hard error (AGENTS.md §3, §9: no silent compatibility shims).
 *
 * Bump in lockstep with `ELIZA_INFERENCE_ABI_VERSION` in
 * `scripts/omnivoice-fuse/ffi.h` whenever the C surface changes shape.
 *
 * v4: the FFI bridge resolves `speaker_preset_id` against the bundle's
 *     `cache/voice-preset-<id>.bin` (ELZ2 v2) and applies the
 *     `(instruct, ref_audio_tokens, ref_T, ref_text)` triple to
 *     `ov_tts_params` before calling `ov_synthesize`. Adds the
 *     `eliza_inference_encode_reference` entrypoint that the freeze CLI
 *     uses to pre-encode reference WAVs into the preset file. A v3 caller
 *     remains source-compatible: every v3 entry point keeps its v3 shape.
 */
export const ELIZA_INFERENCE_ABI_VERSION = 5;
/** Status codes mirrored from `ffi.h`. Negative = failure. */
export const ELIZA_OK = 0;
export const ELIZA_ERR_NOT_IMPLEMENTED = -1;
export const ELIZA_ERR_INVALID_ARG = -2;
export const ELIZA_ERR_BUNDLE_INVALID = -3;
export const ELIZA_ERR_FFI_FAULT = -4;
export const ELIZA_ERR_OOM = -5;
export const ELIZA_ERR_ABI_MISMATCH = -6;
export const ELIZA_ERR_CANCELLED = -7;
/* ---------------------------------------------------------------- */
/* Loader                                                           */
/* ---------------------------------------------------------------- */
/** Runtime detector: returns true when running under Bun. */
function isBunRuntime() {
	return typeof globalThis.Bun !== "undefined";
}
/**
 * Load `libelizainference` at `dylibPath` and bind every symbol
 * declared in `ffi.h`. The returned handle's methods delegate directly
 * to the library; they throw `VoiceLifecycleError` on any negative
 * return value or runtime fault.
 *
 * Throws synchronously (no Promise) when:
 *   - the JS runtime is not Bun (no FFI primitive available),
 *   - `dlopen` cannot find or open the library,
 *   - the library's reported ABI version does not match
 *     `ELIZA_INFERENCE_ABI_VERSION`.
 */
export function loadElizaInferenceFfi(dylibPath) {
	if (!isBunRuntime()) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[ffi-bindings] Cannot load libelizainference: current runtime is not Bun. ` +
				`The fused omnivoice FFI uses bun:ffi (production runs under Bun via Electrobun + Capacitor). ` +
				`process.versions=${JSON.stringify(process.versions)}`,
		);
	}
	if (!dylibPath || dylibPath.length === 0) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			"[ffi-bindings] loadElizaInferenceFfi: dylibPath is required",
		);
	}
	return bindWithBunFfi(dylibPath);
}
/**
 * Resolve `bun:ffi` synchronously via the Bun-injected `require`.
 * Bun exposes a CJS `require` even from ESM modules, and `bun:ffi` is
 * a built-in importable that way. Doing this dynamically (rather than a
 * static `import "bun:ffi"`) keeps the module loadable under plain Node
 * for the parts of the test suite that don't need the FFI.
 */
function loadBunFfiModule() {
	const req = globalThis.Bun?.__require;
	if (typeof req === "function") {
		return req("bun:ffi");
	}
	// Fallback to `module.createRequire` on the current file when running
	// under Bun via an ESM entry without `Bun.__require`. This is rare —
	// current Bun exposes `Bun.__require` — but we keep the path explicit
	// so the failure mode is `MODULE_NOT_FOUND` (a real error), not a
	// silent fall-through.
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const mod = require("node:module");
	const r = mod.createRequire(import.meta.url);
	return r("bun:ffi");
}
function bindWithBunFfi(dylibPath) {
	let ffi;
	try {
		ffi = loadBunFfiModule();
	} catch (err) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[ffi-bindings] Cannot load bun:ffi while opening ${dylibPath}: ${formatFfiError(err)}`,
		);
	}
	const T = ffi.FFIType;
	// All `char *` arguments are typed as T.ptr — Bun's `T.cstring` is a
	// RETURN-only type for "library hands back a NUL-terminated string".
	// For inputs we encode UTF-8 to a NUL-terminated Buffer on the JS
	// side and pass `ffi.ptr(buffer)`.
	let lib = null;
	let nativeVadSymbolsAvailable = true;
	const nativeVadDefs = {
		// Native Silero VAD (ABI v3). These are additive; some transitional
		// builds may report ABI v3 before carrying the VAD symbols, so bind
		// them opportunistically and advertise unsupported if absent.
		eliza_inference_vad_supported: { args: [], returns: T.i32 },
		eliza_inference_vad_open: {
			args: [T.ptr, T.i32, T.ptr],
			returns: T.ptr,
		},
		eliza_inference_vad_process: {
			args: [T.usize, T.ptr, T.usize, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_vad_reset: { args: [T.usize, T.ptr], returns: T.i32 },
		eliza_inference_vad_close: { args: [T.usize], returns: T.void },
	};
	// Streaming LLM (additive on top of v3). Bound opportunistically — when
	// absent the runner falls back to the HTTP `llama-server` path.
	let llmStreamSymbolsAvailable = true;
	const llmStreamDefs = {
		eliza_inference_llm_stream_open: {
			// ctx (ptr), cfg (ptr to eliza_llm_stream_config_t), out_error (ptr)
			args: [T.ptr, T.ptr, T.ptr],
			returns: T.ptr,
		},
		eliza_inference_llm_stream_prefill: {
			args: [T.usize, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		eliza_inference_llm_stream_next: {
			// stream, tokens_out, tokens_cap, num_tokens_out, text_out,
			// text_cap, drafter_drafted_out, drafter_accepted_out, out_error
			args: [
				T.usize,
				T.ptr,
				T.usize,
				T.ptr,
				T.ptr,
				T.usize,
				T.ptr,
				T.ptr,
				T.ptr,
			],
			returns: T.i32,
		},
		eliza_inference_llm_stream_cancel: {
			args: [T.usize],
			returns: T.i32,
		},
		eliza_inference_llm_stream_save_slot: {
			args: [T.usize, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_llm_stream_restore_slot: {
			args: [T.usize, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_llm_stream_close: {
			args: [T.usize],
			returns: T.void,
		},
	};
	const referenceEncodeDefs = {
		// OmniVoice reference encode (ABI v4) — optional for transitional
		// fused libraries. Default TTS/ASR must still load when reference-clone
		// freezing is unavailable; encodeReferenceSupported() exposes that state.
		eliza_inference_encode_reference: {
			// ctx, pcm, n_samples, sample_rate_hz, out_K, out_ref_T, out_tokens (int**), out_error
			args: [T.ptr, T.ptr, T.usize, T.i32, T.ptr, T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_free_tokens: { args: [T.usize], returns: T.void },
	};
	let referenceEncodeSymbolsAvailable = true;
	const coreDefs = {
		eliza_inference_abi_version: { args: [], returns: T.cstring },
		eliza_inference_create: {
			args: [T.ptr, T.ptr],
			returns: T.ptr,
		},
		eliza_inference_destroy: { args: [T.ptr], returns: T.void },
		eliza_inference_mmap_acquire: {
			args: [T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_mmap_evict: {
			args: [T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_tts_synthesize: {
			args: [T.ptr, T.ptr, T.usize, T.ptr, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		eliza_inference_asr_transcribe: {
			args: [T.ptr, T.ptr, T.usize, T.i32, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		// Streaming TTS + native verifier callback (ABI v2). The
		// function-pointer args are passed as raw pointer values
		// (`JSCallback.ptr`, or 0n to clear) so this binding owns the
		// JSCallback lifetime explicitly — see `ttsSynthesizeStream` /
		// `setVerifierCallback` below.
		eliza_inference_tts_stream_supported: { args: [], returns: T.i32 },
		eliza_inference_tts_synthesize_stream: {
			// ctx, text, text_len, speaker, on_chunk (fn ptr), user_data, out_error
			args: [T.ptr, T.ptr, T.usize, T.ptr, T.usize, T.usize, T.ptr],
			returns: T.i32,
		},
		eliza_inference_cancel_tts: { args: [T.ptr, T.ptr], returns: T.i32 },
		eliza_inference_set_verifier_callback: {
			// ctx, cb (fn ptr — 0 to clear), user_data, out_error
			args: [T.ptr, T.usize, T.usize, T.ptr],
			returns: T.i32,
		},
		// Streaming ASR (ABI v2).
		eliza_inference_asr_stream_supported: { args: [], returns: T.i32 },
		eliza_inference_asr_stream_open: {
			args: [T.ptr, T.i32, T.ptr],
			returns: T.ptr,
		},
		eliza_inference_asr_stream_feed: {
			// stream handle is a raw C pointer → pass as usize.
			args: [T.usize, T.ptr, T.usize, T.ptr],
			returns: T.i32,
		},
		eliza_inference_asr_stream_partial: {
			args: [T.usize, T.ptr, T.usize, T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_asr_stream_finish: {
			args: [T.usize, T.ptr, T.usize, T.ptr, T.ptr, T.ptr],
			returns: T.i32,
		},
		eliza_inference_asr_stream_close: { args: [T.usize], returns: T.void },
		// Bun 1.3.x accepts raw pointer values passed back into C as
		// `usize`, while `ptr` is for JS-owned ArrayBuffer pointers.
		eliza_inference_free_string: { args: [T.usize], returns: T.void },
	};
	// Try the maximal additive symbol set first, then progressively drop
	// optional families. Each fallback flips a sentinel so `*Supported()` probes
	// report false instead of making an unavailable native call.
	const attempts = [
		{
			defs: {
				...coreDefs,
				...referenceEncodeDefs,
				...nativeVadDefs,
				...llmStreamDefs,
			},
			referenceEncode: true,
			nativeVad: true,
			llmStream: true,
		},
		{
			defs: { ...coreDefs, ...nativeVadDefs, ...llmStreamDefs },
			referenceEncode: false,
			nativeVad: true,
			llmStream: true,
		},
		{
			defs: { ...coreDefs, ...referenceEncodeDefs, ...nativeVadDefs },
			referenceEncode: true,
			nativeVad: true,
			llmStream: false,
		},
		{
			defs: { ...coreDefs, ...nativeVadDefs },
			referenceEncode: false,
			nativeVad: true,
			llmStream: false,
		},
		{
			defs: { ...coreDefs, ...referenceEncodeDefs },
			referenceEncode: true,
			nativeVad: false,
			llmStream: false,
		},
		{
			defs: coreDefs,
			referenceEncode: false,
			nativeVad: false,
			llmStream: false,
		},
	];
	let lastOpenError = null;
	for (const attempt of attempts) {
		try {
			lib = ffi.dlopen(dylibPath, attempt.defs);
			referenceEncodeSymbolsAvailable = attempt.referenceEncode;
			nativeVadSymbolsAvailable = attempt.nativeVad;
			llmStreamSymbolsAvailable = attempt.llmStream;
			break;
		} catch (err) {
			lastOpenError = err;
		}
	}
	if (lib === null) {
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[ffi-bindings] Failed to open libelizainference at ${dylibPath}: ${formatFfiError(lastOpenError)}`,
		);
	}
	const loadedLib = lib;
	// ABI version check. v4 is the current full surface; v3 is accepted only
	// when the optional reference-encode symbols are absent so default TTS/ASR
	// can still run while sample-to-profile freezing stays explicitly disabled.
	const reported = readCString(
		loadedLib.symbols.eliza_inference_abi_version(),
		ffi,
	);
	const abiOk =
		reported === String(ELIZA_INFERENCE_ABI_VERSION) ||
		(reported === "3" && !referenceEncodeSymbolsAvailable);
	if (!abiOk) {
		loadedLib.close();
		throw new VoiceLifecycleError(
			"kernel-missing",
			`[ffi-bindings] ABI mismatch: binding expected v${ELIZA_INFERENCE_ABI_VERSION}, ` +
				`library at ${dylibPath} reports v${reported}. The fused build was produced ` +
				`against a different ffi.h — rebuild against the current header.`,
		);
	}
	/**
	 * Read `*outErrPtr` (a `char**` that the library populated with a
	 * heap-allocated NUL-terminated string), free the underlying buffer
	 * via `eliza_inference_free_string`, and return the JS string. When
	 * the library left `*outErrPtr` as NULL, returns null.
	 */
	function takeError(outErrPtrBuf) {
		const ptrValue = outErrPtrBuf[0];
		if (ptrValue === undefined || ptrValue === 0n) return null;
		const ptrNumber = Number(ptrValue);
		if (!Number.isSafeInteger(ptrNumber)) {
			throw new VoiceLifecycleError(
				"kernel-missing",
				`[ffi-bindings] C diagnostic pointer ${ptrValue.toString()} exceeds JS safe integer range`,
			);
		}
		const cstr = new ffi.CString(ptrNumber);
		const message = cstr.toString();
		loadedLib.symbols.eliza_inference_free_string(ptrValue);
		return message;
	}
	function makeOutErr() {
		const buf = new BigUint64Array(1);
		return { buf, ptr: ffi.ptr(buf) };
	}
	/**
	 * Encode a JS string to a NUL-terminated UTF-8 buffer and return a
	 * `T.ptr`-compatible pointer suitable for `const char *` arguments.
	 * Returns null when the input is null — the C ABI accepts NULL for
	 * optional arguments like `speaker_preset_id`.
	 */
	function cstr(value) {
		if (value === null) return { ptr: null, bytes: 0, buffer: null };
		const bytes = Buffer.from(value, "utf8");
		const buf = Buffer.alloc(bytes.byteLength + 1);
		bytes.copy(buf);
		return { ptr: ffi.ptr(buf), bytes: bytes.byteLength, buffer: buf };
	}
	function failureCode(rc) {
		if (rc === ELIZA_ERR_OOM) return "ram-pressure";
		if (rc === ELIZA_ERR_FFI_FAULT) return "mmap-fail";
		if (rc === ELIZA_ERR_NOT_IMPLEMENTED) return "kernel-missing";
		if (rc === ELIZA_ERR_ABI_MISMATCH) return "kernel-missing";
		if (rc === ELIZA_ERR_BUNDLE_INVALID) return "kernel-missing";
		return "kernel-missing";
	}
	function isNullPointer(value) {
		return value === null || value === undefined || value === 0n || value === 0;
	}
	return {
		libraryPath: dylibPath,
		libraryAbiVersion: reported,
		create(bundleDir) {
			const err = makeOutErr();
			const bundleArg = cstr(bundleDir);
			const handle = loadedLib.symbols.eliza_inference_create(
				bundleArg.ptr,
				err.ptr,
			);
			if (isNullPointer(handle)) {
				const message =
					takeError(err.buf) ??
					"[ffi-bindings] eliza_inference_create returned NULL with no diagnostic";
				throw new VoiceLifecycleError("kernel-missing", message);
			}
			return handle;
		},
		destroy(ctx) {
			loadedLib.symbols.eliza_inference_destroy(ctx);
		},
		mmapAcquire(ctx, region) {
			const err = makeOutErr();
			const regionArg = cstr(region);
			const rc = loadedLib.symbols.eliza_inference_mmap_acquire(
				ctx,
				regionArg.ptr,
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_mmap_acquire(${region}) rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},
		mmapEvict(ctx, region) {
			const err = makeOutErr();
			const regionArg = cstr(region);
			const rc = loadedLib.symbols.eliza_inference_mmap_evict(
				ctx,
				regionArg.ptr,
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_mmap_evict(${region}) rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},
		ttsSynthesize({ ctx, text, speakerPresetId, out }) {
			const err = makeOutErr();
			const textArg = cstr(text);
			const speakerArg = cstr(speakerPresetId);
			const rc = loadedLib.symbols.eliza_inference_tts_synthesize(
				ctx,
				textArg.ptr,
				BigInt(textArg.bytes),
				speakerArg.ptr,
				ffi.ptr(out),
				BigInt(out.length),
				err.ptr,
			);
			if (rc < 0) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_tts_synthesize rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			return rc;
		},
		asrTranscribe({ ctx, pcm, sampleRateHz, maxTextBytes }) {
			const err = makeOutErr();
			const cap = maxTextBytes ?? 4096;
			const outText = new Uint8Array(cap);
			const rc = loadedLib.symbols.eliza_inference_asr_transcribe(
				ctx,
				ffi.ptr(pcm),
				BigInt(pcm.length),
				sampleRateHz,
				ffi.ptr(outText),
				BigInt(cap),
				err.ptr,
			);
			if (rc < 0) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_asr_transcribe rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			const nul = outText.indexOf(0, 0);
			const len = nul >= 0 ? nul : rc;
			return Buffer.from(outText.buffer, outText.byteOffset, len).toString(
				"utf8",
			);
		},
		/* ---- Streaming TTS + verifier callback (ABI v2) ------------ */
		ttsStreamSupported() {
			return loadedLib.symbols.eliza_inference_tts_stream_supported() === 1;
		},
		ttsSynthesizeStream({ ctx, text, speakerPresetId, onChunk }) {
			const err = makeOutErr();
			const textArg = cstr(text);
			const speakerArg = cstr(speakerPresetId);
			// (pcm: ptr, n_samples: usize, is_final: i32, user_data: ptr) -> i32
			const cb = new ffi.JSCallback(
				(pcmPtr, nSamples, isFinal) => {
					const n = Number(nSamples);
					// Bun delivers the C pointer as a bigint; copy the floats out
					// before returning — the buffer is the library's, valid only
					// for this call.
					const pcm =
						n > 0 && pcmPtr !== 0n
							? new Float32Array(ffi.toArrayBuffer(pcmPtr, 0, n * 4).slice(0))
							: new Float32Array(0);
					const requestCancel = onChunk({ pcm, isFinal: isFinal !== 0 });
					return requestCancel === true ? 1 : 0;
				},
				{
					args: [T.ptr, T.usize, T.i32, T.ptr],
					returns: T.i32,
				},
			);
			try {
				const rc = loadedLib.symbols.eliza_inference_tts_synthesize_stream(
					ctx,
					textArg.ptr,
					BigInt(textArg.bytes),
					speakerArg.ptr,
					BigInt(cb.ptr),
					0n,
					err.ptr,
				);
				if (rc === ELIZA_ERR_CANCELLED) return { cancelled: true };
				if (rc < 0) {
					const message =
						takeError(err.buf) ??
						`[ffi-bindings] eliza_inference_tts_synthesize_stream rc=${rc}`;
					throw new VoiceLifecycleError(failureCode(rc), message);
				}
				return { cancelled: false };
			} finally {
				cb.close();
			}
		},
		cancelTts(ctx) {
			const err = makeOutErr();
			const rc = loadedLib.symbols.eliza_inference_cancel_tts(ctx, err.ptr);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_cancel_tts rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},
		encodeReferenceSupported() {
			return (
				typeof loadedLib.symbols.eliza_inference_encode_reference === "function"
			);
		},
		encodeReference({ ctx, pcm, sampleRateHz }) {
			if (
				typeof loadedLib.symbols.eliza_inference_encode_reference !==
					"function" ||
				typeof loadedLib.symbols.eliza_inference_free_tokens !== "function"
			) {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_encode_reference is not exported by this build",
				);
			}
			if (sampleRateHz !== 24000) {
				throw new VoiceLifecycleError(
					"kernel-missing",
					`[ffi-bindings] encodeReference: sampleRateHz must be 24000 (got ${sampleRateHz})`,
				);
			}
			const err = makeOutErr();
			// out_K and out_ref_T are int*, out_tokens is int** — give the library
			// a slot to write into, then read back.
			const outK = new Int32Array(1);
			const outRefT = new Int32Array(1);
			const outTokensPtr = new BigUint64Array(1);
			const rc = loadedLib.symbols.eliza_inference_encode_reference(
				ctx,
				ffi.ptr(pcm),
				BigInt(pcm.length),
				sampleRateHz,
				ffi.ptr(outK),
				ffi.ptr(outRefT),
				ffi.ptr(outTokensPtr),
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_encode_reference rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			const K = outK[0];
			const refT = outRefT[0];
			const tokensRaw = outTokensPtr[0];
			if (K <= 0 || refT <= 0 || tokensRaw === 0n) {
				throw new VoiceLifecycleError(
					"kernel-missing",
					`[ffi-bindings] encodeReference returned empty result (K=${K}, refT=${refT})`,
				);
			}
			const tokenCount = K * refT;
			try {
				// Copy out of the library's malloc'ed buffer so we can free it
				// before returning. Each int32 is 4 bytes.
				const tokenBytes = tokenCount * 4;
				const tokensPtr =
					typeof tokensRaw === "bigint" ? Number(tokensRaw) : tokensRaw;
				const nativeView = ffi.toArrayBuffer(tokensPtr, 0, tokenBytes);
				const bytes = new Uint8Array(nativeView);
				if (bytes.byteLength < tokenBytes) {
					throw new VoiceLifecycleError(
						"kernel-missing",
						`[ffi-bindings] encodeReference returned an unreadable token buffer (K=${K}, refT=${refT}, got=${bytes.byteLength}, expected=${tokenBytes}, ctor=${nativeView.constructor.name})`,
					);
				}
				const copied = bytes.slice(0, tokenBytes);
				const tokens = new Int32Array(copied.buffer);
				return { K, refT, tokens };
			} finally {
				loadedLib.symbols.eliza_inference_free_tokens(tokensRaw);
			}
		},
		setVerifierCallback(ctx, cbFn) {
			const err = makeOutErr();
			if (cbFn === null) {
				const rc = loadedLib.symbols.eliza_inference_set_verifier_callback(
					ctx,
					0n,
					0n,
					err.ptr,
				);
				if (rc !== ELIZA_OK) {
					const message =
						takeError(err.buf) ??
						`[ffi-bindings] eliza_inference_set_verifier_callback(clear) rc=${rc}`;
					throw new VoiceLifecycleError(failureCode(rc), message);
				}
				return { close: () => {} };
			}
			// (ev: ptr to EliVerifierEvent, user_data: ptr) -> void
			const cb = new ffi.JSCallback(
				(evPtr) => {
					cbFn(readVerifierEvent(evPtr, ffi));
				},
				{ args: [T.ptr, T.ptr], returns: T.void },
			);
			const rc = loadedLib.symbols.eliza_inference_set_verifier_callback(
				ctx,
				BigInt(cb.ptr),
				0n,
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				cb.close();
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_set_verifier_callback rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			return {
				close: () => {
					// Clear the native registration FIRST, then free the
					// JSCallback — order matters so the native side never
					// dereferences a closed callback.
					const clearErr = makeOutErr();
					loadedLib.symbols.eliza_inference_set_verifier_callback(
						ctx,
						0n,
						0n,
						clearErr.ptr,
					);
					takeError(clearErr.buf);
					cb.close();
				},
			};
		},
		/* ---- Native VAD (ABI v3) ----------------------------------- */
		vadSupported() {
			if (
				!nativeVadSymbolsAvailable ||
				typeof loadedLib.symbols.eliza_inference_vad_supported !== "function"
			) {
				return false;
			}
			return loadedLib.symbols.eliza_inference_vad_supported() === 1;
		},
		vadOpen({ ctx, sampleRateHz }) {
			const open = loadedLib.symbols.eliza_inference_vad_open;
			if (!nativeVadSymbolsAvailable || typeof open !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_vad_open is not exported by this libelizainference build",
				);
			}
			const err = makeOutErr();
			const handle = open(ctx, sampleRateHz, err.ptr);
			if (isNullPointer(handle)) {
				const message =
					takeError(err.buf) ??
					"[ffi-bindings] eliza_inference_vad_open returned NULL with no diagnostic";
				throw new VoiceLifecycleError("kernel-missing", message);
			}
			return handle;
		},
		vadProcess({ vad, pcm }) {
			const process = loadedLib.symbols.eliza_inference_vad_process;
			if (!nativeVadSymbolsAvailable || typeof process !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_vad_process is not exported by this libelizainference build",
				);
			}
			const err = makeOutErr();
			const outProbability = new Float32Array(1);
			const rc = process(
				vad,
				ffi.ptr(pcm),
				BigInt(pcm.length),
				ffi.ptr(outProbability),
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_vad_process rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			return outProbability[0] ?? 0;
		},
		vadReset(vad) {
			const reset = loadedLib.symbols.eliza_inference_vad_reset;
			if (!nativeVadSymbolsAvailable || typeof reset !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_vad_reset is not exported by this libelizainference build",
				);
			}
			const err = makeOutErr();
			const rc = reset(vad, err.ptr);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_vad_reset rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},
		vadClose(vad) {
			loadedLib.symbols.eliza_inference_vad_close?.(vad);
		},
		/* ---- Streaming ASR (ABI v2) -------------------------------- */
		asrStreamSupported() {
			return loadedLib.symbols.eliza_inference_asr_stream_supported() === 1;
		},
		asrStreamOpen({ ctx, sampleRateHz }) {
			const err = makeOutErr();
			const handle = loadedLib.symbols.eliza_inference_asr_stream_open(
				ctx,
				sampleRateHz,
				err.ptr,
			);
			if (isNullPointer(handle)) {
				const message =
					takeError(err.buf) ??
					"[ffi-bindings] eliza_inference_asr_stream_open returned NULL with no diagnostic";
				throw new VoiceLifecycleError("kernel-missing", message);
			}
			return handle;
		},
		asrStreamFeed({ stream, pcm }) {
			const err = makeOutErr();
			const rc = loadedLib.symbols.eliza_inference_asr_stream_feed(
				stream,
				ffi.ptr(pcm),
				BigInt(pcm.length),
				err.ptr,
			);
			if (rc < 0) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_asr_stream_feed rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},
		asrStreamPartial(args) {
			return readAsrStreamResult(
				"partial",
				loadedLib.symbols.eliza_inference_asr_stream_partial,
				args,
			);
		},
		asrStreamFinish(args) {
			return readAsrStreamResult(
				"finish",
				loadedLib.symbols.eliza_inference_asr_stream_finish,
				args,
			);
		},
		asrStreamClose(stream) {
			loadedLib.symbols.eliza_inference_asr_stream_close(stream);
		},
		/* ---- Streaming LLM (additive on top of v3) ----------------- */
		llmStreamSupported() {
			// Symbols are bound at dlopen — if the fallback path stripped them
			// out, the runtime never advertises support.
			return (
				llmStreamSymbolsAvailable &&
				typeof loadedLib.symbols.eliza_inference_llm_stream_open === "function"
			);
		},
		llmStreamOpen({ ctx, config }) {
			const open = loadedLib.symbols.eliza_inference_llm_stream_open;
			if (!llmStreamSymbolsAvailable || typeof open !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_llm_stream_open is not exported by this build",
				);
			}
			const err = makeOutErr();
			// Marshal the config struct into a Buffer. Layout (8-byte aligned):
			//   off  0 : i32  max_tokens
			//   off  4 : f32  temperature
			//   off  8 : f32  top_p
			//   off 12 : i32  top_k
			//   off 16 : f32  repeat_penalty
			//   off 20 : i32  slot_id
			//   off 24 : ptr  prompt_cache_key
			//   off 32 : i32  draft_min
			//   off 36 : i32  draft_max
			//   off 40 : ptr  dflash_drafter_path
			//   sizeof = 48
			const buf = Buffer.alloc(48);
			buf.writeInt32LE(config.maxTokens, 0);
			buf.writeFloatLE(config.temperature, 4);
			buf.writeFloatLE(config.topP, 8);
			buf.writeInt32LE(config.topK, 12);
			buf.writeFloatLE(config.repeatPenalty, 16);
			buf.writeInt32LE(config.slotId, 20);
			const keyArg = cstr(config.promptCacheKey);
			const drafterArg = cstr(config.dflashDrafterPath);
			buf.writeBigUInt64LE(toPtrBigInt(keyArg.ptr), 24);
			buf.writeInt32LE(config.draftMin, 32);
			buf.writeInt32LE(config.draftMax, 36);
			buf.writeBigUInt64LE(toPtrBigInt(drafterArg.ptr), 40);
			const handle = open(ctx, ffi.ptr(buf), err.ptr);
			if (isNullPointer(handle)) {
				const message =
					takeError(err.buf) ??
					"[ffi-bindings] eliza_inference_llm_stream_open returned NULL with no diagnostic";
				throw new VoiceLifecycleError("kernel-missing", message);
			}
			return handle;
		},
		llmStreamPrefill({ stream, tokens }) {
			const prefill = loadedLib.symbols.eliza_inference_llm_stream_prefill;
			if (!llmStreamSymbolsAvailable || typeof prefill !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_llm_stream_prefill is not exported by this build",
				);
			}
			const err = makeOutErr();
			const rc = prefill(
				stream,
				ffi.ptr(tokens),
				BigInt(tokens.length),
				err.ptr,
			);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_llm_stream_prefill rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},
		llmStreamNext({ stream, maxTokensPerStep, maxTextBytes }) {
			const next = loadedLib.symbols.eliza_inference_llm_stream_next;
			if (!llmStreamSymbolsAvailable || typeof next !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_llm_stream_next is not exported by this build",
				);
			}
			const err = makeOutErr();
			const tokenCap = maxTokensPerStep ?? 32;
			const textCap = maxTextBytes ?? 1024;
			const tokensOut = new Int32Array(tokenCap);
			const numTokensOut = new BigUint64Array(1);
			const textOut = new Uint8Array(textCap);
			const drafterDrafted = new Int32Array(1);
			const drafterAccepted = new Int32Array(1);
			const rc = next(
				stream,
				ffi.ptr(tokensOut),
				BigInt(tokenCap),
				ffi.ptr(numTokensOut),
				ffi.ptr(textOut),
				BigInt(textCap),
				ffi.ptr(drafterDrafted),
				ffi.ptr(drafterAccepted),
				err.ptr,
			);
			if (rc < 0) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_llm_stream_next rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
			const n = Number(numTokensOut[0] ?? 0n);
			const tokens = Array.from(tokensOut.subarray(0, Math.min(n, tokenCap)));
			const nul = textOut.indexOf(0, 0);
			const len = nul >= 0 ? nul : textCap;
			const text = Buffer.from(
				textOut.buffer,
				textOut.byteOffset,
				len,
			).toString("utf8");
			return {
				tokens,
				text,
				done: rc === 1,
				drafterDrafted: drafterDrafted[0] ?? 0,
				drafterAccepted: drafterAccepted[0] ?? 0,
			};
		},
		llmStreamCancel(stream) {
			const cancel = loadedLib.symbols.eliza_inference_llm_stream_cancel;
			if (!llmStreamSymbolsAvailable || typeof cancel !== "function") {
				// Cancel is best-effort — a build without the symbol just means
				// the runtime cannot interrupt mid-step. The next `_next` call
				// will still finish normally; the caller drops the result.
				return;
			}
			cancel(stream);
		},
		llmStreamSaveSlot({ stream, filename }) {
			const save = loadedLib.symbols.eliza_inference_llm_stream_save_slot;
			if (!llmStreamSymbolsAvailable || typeof save !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_llm_stream_save_slot is not exported by this build",
				);
			}
			const err = makeOutErr();
			const fnameArg = cstr(filename);
			const rc = save(stream, fnameArg.ptr, err.ptr);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_llm_stream_save_slot rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},
		llmStreamRestoreSlot({ stream, filename }) {
			const restore = loadedLib.symbols.eliza_inference_llm_stream_restore_slot;
			if (!llmStreamSymbolsAvailable || typeof restore !== "function") {
				throw new VoiceLifecycleError(
					"kernel-missing",
					"[ffi-bindings] eliza_inference_llm_stream_restore_slot is not exported by this build",
				);
			}
			const err = makeOutErr();
			const fnameArg = cstr(filename);
			const rc = restore(stream, fnameArg.ptr, err.ptr);
			if (rc !== ELIZA_OK) {
				const message =
					takeError(err.buf) ??
					`[ffi-bindings] eliza_inference_llm_stream_restore_slot rc=${rc}`;
				throw new VoiceLifecycleError(failureCode(rc), message);
			}
		},
		llmStreamClose(stream) {
			loadedLib.symbols.eliza_inference_llm_stream_close?.(stream);
		},
		close() {
			loadedLib.close();
		},
	};
	/**
	 * Convert a Bun-FFI pointer value (`unknown` per the lazy types) to the
	 * bigint the marshalled config struct stores in its `const char *`
	 * slots. NULL inputs translate to `0n`. Used by `llmStreamOpen` to
	 * inline the cstr pointers into the config buffer.
	 */
	function toPtrBigInt(value) {
		if (value === null || value === undefined) return 0n;
		if (typeof value === "bigint") return value;
		if (typeof value === "number") return BigInt(value);
		// Bun returns its internal pointer object that coerces to bigint.
		return BigInt(value);
	}
	/**
	 * Shared body for `asr_stream_partial` / `asr_stream_finish` — both
	 * have the same 6-arg shape (`stream, out_text, max_text_bytes,
	 * out_tokens, io_n_tokens, out_error`). Token ids are read only when
	 * the caller asks for them (`maxTokens > 0`); otherwise the
	 * out_tokens / io_n_tokens pointers are NULL.
	 */
	function readAsrStreamResult(label, fn, args) {
		const err = makeOutErr();
		const textCap = args.maxTextBytes ?? 4096;
		const outText = new Uint8Array(textCap);
		const wantTokens = (args.maxTokens ?? 0) > 0;
		const tokenCap = wantTokens ? args.maxTokens : 0;
		const outTokens = wantTokens ? new Int32Array(tokenCap) : null;
		const ioNTokens = wantTokens
			? new BigUint64Array([BigInt(tokenCap)])
			: null;
		const rc = fn(
			args.stream,
			ffi.ptr(outText),
			BigInt(textCap),
			outTokens ? ffi.ptr(outTokens) : null,
			ioNTokens ? ffi.ptr(ioNTokens) : null,
			err.ptr,
		);
		if (rc < 0) {
			const message =
				takeError(err.buf) ??
				`[ffi-bindings] eliza_inference_asr_stream_${label} rc=${rc}`;
			throw new VoiceLifecycleError(failureCode(rc), message);
		}
		const nul = outText.indexOf(0, 0);
		const len = nul >= 0 ? nul : rc;
		const partial = Buffer.from(
			outText.buffer,
			outText.byteOffset,
			len,
		).toString("utf8");
		if (wantTokens && outTokens && ioNTokens) {
			const n = Number(ioNTokens[0] ?? 0n);
			const tokens = Array.from(outTokens.subarray(0, Math.min(n, tokenCap)));
			return { partial, tokens };
		}
		return { partial };
	}
}
function formatFfiError(err) {
	if (err instanceof Error) {
		return err.message;
	}
	return String(err);
}
/**
 * Read an `EliVerifierEvent` (see `ffi.h`) from a C struct pointer.
 * Layout on 64-bit (8-byte aligned, default packing):
 *   off 0  : const int* accepted_token_ids   (8)
 *   off 8  : size_t      n_accepted           (8)
 *   off 16 : int         rejected_from        (4)
 *   off 20 : int         rejected_to          (4)
 *   off 24 : const int*  corrected_token_ids  (8)
 *   off 32 : size_t      n_corrected          (8)
 */
function readVerifierEvent(evPtr, ffi) {
	const acceptedPtr = ffi.read.ptr(evPtr, 0);
	const nAccepted = Number(ffi.read.u64(evPtr, 8));
	const rejectedFrom = ffi.read.i32(evPtr, 16);
	const rejectedTo = ffi.read.i32(evPtr, 20);
	const correctedPtr = ffi.read.ptr(evPtr, 24);
	const nCorrected = Number(ffi.read.u64(evPtr, 32));
	return {
		acceptedTokenIds: readInt32Array(acceptedPtr, nAccepted, ffi),
		rejectedFrom,
		rejectedTo,
		correctedTokenIds: readInt32Array(correctedPtr, nCorrected, ffi),
	};
}
function readInt32Array(ptr, count, ffi) {
	if (ptr === 0n || count <= 0) return [];
	// Copy out — the array is the library's, valid only for the callback.
	const view = new Int32Array(ffi.toArrayBuffer(ptr, 0, count * 4).slice(0));
	return Array.from(view);
}
/**
 * Decode a `T.cstring` return value (Bun returns these as either a
 * lazy string-like object with `toString()` or a JS string depending
 * on version). Wrap so the caller never has to branch.
 */
function readCString(value, ffi) {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	if (typeof value === "object" && value !== null && "toString" in value) {
		return value.toString();
	}
	if (typeof value === "number" || typeof value === "bigint") {
		return new ffi.CString(value).toString();
	}
	return String(value);
}
//# sourceMappingURL=ffi-bindings.js.map
