/**
 * Explicit host-only ASR worker on libelizainference (ABI v17).
 * Protocol uses fd 3; diagnostics never reach callers.
 *
 * Environment: ELIZA_INFERENCE_LIBRARY + ELIZA_INFERENCE_LIBRARY_SHA256, and an
 * absolute ELIZA_ASR_MODEL_DIR holding the pinned Qwen3-ASR-0.6B Q8_0 pair as
 * `asr/eliza-1-asr.gguf` and `asr/eliza-1-asr-mmproj.gguf`. The worker loads
 * only the ASR region; it never loads a text model, downloads or falls back.
 *
 * Requests: `{id, op:"transcribe", pcm, encoding:"s16"|"f32", sampleRate}`
 * (`pcm` is base64 little-endian mono samples) returns `{id, text}` or
 * `{id, error}`. `{op:"cancel", id}` calls `eliza_inference_asr_cancel` for the
 * request in flight. After two idle minutes the worker calls
 * `mmap_evict("asr")`; the next request loads the region again.
 */
import { isMainThread } from "node:worker_threads";
import {
	type PinnedSpeechAsset,
	serveSpeechEngine,
	serveSpeechProtocol,
	verifiedInferenceLibrary,
	verifyPinnedAssets,
} from "./host-speech-runtime";
import { loadElizaInferenceFfi } from "./services/voice/ffi-bindings";

/**
 * Qwen3-ASR-0.6B Q8_0 text GGUF + audio mmproj, the pair the fused ASR path
 * loads from `<bundle>/asr/`.
 * TODO: read these from the voice model registry record once it carries the
 * Qwen3-ASR pair, so the pins live in one place.
 */
export const ASR_ASSETS: readonly PinnedSpeechAsset[] = [
	{
		path: "asr/eliza-1-asr.gguf",
		sha256: "bca259818b50ca7c4c05e9bdb35a5dc04fa039653a6d6f3f0f331f96f6aa1971",
		bytes: 804_749_248,
	},
	{
		path: "asr/eliza-1-asr-mmproj.gguf",
		sha256: "41a342b5e4c514e968cb756de6cd1b7be39eff43c44c57a2ef5fc6522e36603d",
		bytes: 214_392_480,
	},
];
const MAX_SECONDS = 60;

interface TranscriptionRequest {
	id: string;
	pcm: string;
	encoding: "s16" | "f32";
	sampleRate: number;
}

function samples(request: TranscriptionRequest): Float32Array {
	const bytes = Buffer.from(request.pcm, "base64");
	const width = request.encoding === "f32" ? 4 : 2;
	if (!bytes.length || bytes.length % width)
		throw Error("Invalid speech audio");
	const count = bytes.length / width;
	if (count > MAX_SECONDS * request.sampleRate)
		throw Error("Speech exceeds duration limit");
	const pcm = new Float32Array(count);
	for (let i = 0; i < count; i++) {
		const value =
			width === 4 ? bytes.readFloatLE(i * 4) : bytes.readInt16LE(i * 2) / 32768;
		if (!Number.isFinite(value)) throw Error("Invalid speech sample");
		pcm[i] = value;
	}
	return pcm;
}

// The engine thread runs in this process after the protocol thread verified
// the library and models, so it does not hash them again.
const library = isMainThread
	? verifiedInferenceLibrary()
	: process.env.ELIZA_INFERENCE_LIBRARY || "";
const root = process.env.ELIZA_ASR_MODEL_DIR || "";

if (isMainThread) {
	verifyPinnedAssets(root, ASR_ASSETS);
	const ffi = loadElizaInferenceFfi(library);
	try {
		if (
			Number(ffi.libraryAbiVersion) < 17 ||
			!ffi.asrSupported?.() ||
			!ffi.asrCancel
		)
			throw Error("Unsupported speech ABI");
		const cancel = ffi.asrCancel;
		await serveSpeechProtocol<TranscriptionRequest>({
			engineUrl: new URL(import.meta.url),
			// 60 s of f32 at 48 kHz, base64-encoded, plus the envelope.
			maxLine: 16 * 1024 * 1024,
			idleReleaseMs: 120_000,
			parse(input) {
				if (
					input.op !== "transcribe" ||
					typeof input.pcm !== "string" ||
					!input.pcm ||
					(input.encoding !== "s16" && input.encoding !== "f32") ||
					!Number.isInteger(input.sampleRate) ||
					(input.sampleRate as number) < 8000 ||
					(input.sampleRate as number) > 48000
				)
					throw Error("Invalid speech request");
				return {
					id: input.id as string,
					pcm: input.pcm,
					encoding: input.encoding,
					sampleRate: input.sampleRate as number,
				};
			},
			cancel: (ctx) => cancel(ctx),
		});
	} finally {
		ffi.close();
	}
} else {
	serveSpeechEngine<TranscriptionRequest>(() => {
		const ffi = loadElizaInferenceFfi(library);
		const ctx = ffi.create(root);
		let acquired = false;
		const acquire = () => {
			if (acquired) return;
			ffi.mmapAcquire(ctx, "asr");
			acquired = true;
		};
		try {
			acquire();
		} catch (error) {
			ffi.destroy(ctx);
			ffi.close();
			throw error;
		}
		return {
			ctx,
			run(request) {
				const pcm = samples(request);
				acquire();
				const text = ffi.asrTranscribe({
					ctx,
					pcm,
					sampleRateHz: request.sampleRate,
				});
				return { text: text.trim() };
			},
			release() {
				if (!acquired) return;
				acquired = false;
				ffi.mmapEvict(ctx, "asr");
			},
			dispose() {
				ffi.destroy(ctx);
				ffi.close();
			},
		};
	});
}
