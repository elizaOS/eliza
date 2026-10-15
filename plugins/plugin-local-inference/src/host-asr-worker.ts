/**
 * Explicit host-only ASR worker on libelizainference (ABI v17).
 * Protocol uses fd 3; diagnostics never reach callers.
 *
 * Environment: ELIZA_INFERENCE_LIBRARY + ELIZA_INFERENCE_LIBRARY_SHA256, and an
 * absolute ELIZA_ASR_MODEL_DIR holding `vad/silero-vad-v5.gguf` and the pinned
 * Phonon-2 GGUF `asr/phonon-2-fv5.gguf` (see host-asr-assets.ts), which runs
 * on the library's Parakeet-TDT backend (CC-BY-4.0; the NOTICE ships with it).
 * ELIZA_ASR_THREADS sets the decode threads; ELIZA_ASR_BACKEND may only be
 * unset or an in-tree selector such as `ggml`. The worker loads the ASR region and pinned
 * Silero VAD; it never loads a text model, downloads or falls back.
 *
 * Requests: `{id, op:"transcribe", pcm, encoding:"s16"|"f32", sampleRate}`
 * (`pcm` is base64 little-endian mono samples) returns `{id, text}` or
 * `{id, error}`. `{op:"cancel", id}` calls `eliza_inference_asr_cancel` for the
 * request in flight. After two idle minutes the worker calls
 * `mmap_evict("asr")`; the next request loads the region again.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isMainThread } from "node:worker_threads";
import { PHONON_ASR_ASSETS, selectHostAsrAssets } from "./host-asr-assets";
import {
	type PinnedSpeechAsset,
	serveSpeechEngine,
	serveSpeechProtocol,
	verifiedInferenceLibrary,
	verifyPinnedAssets,
} from "./host-speech-runtime";
import {
	loadElizaInferenceFfi,
	type NativeVadHandle,
} from "./services/voice/ffi-bindings";
import { resampleLinear } from "./services/voice/transcriber";

/** The pinned Phonon-2 GGUF the worker verifies. */
export const ASR_ASSETS: readonly PinnedSpeechAsset[] = PHONON_ASR_ASSETS;
export { PHONON_ASR_ASSETS };

const VAD_ASSET: PinnedSpeechAsset = {
	path: "vad/silero-vad-v5.gguf",
	sha256: "d348cd6d87ea53dcd3e6680698c88be326082e27dae899adef653d090bee4995",
	bytes: 620736,
};
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
	verifyPinnedAssets(root, [...selectHostAsrAssets(root), VAD_ASSET]);
	// The native VAD loader selects the first GGUF recursively. Ensure it can
	// select only the model whose bytes were verified above.
	const candidates = readdirSync(join(root, "vad"), {
		recursive: true,
		encoding: "utf8",
	}).filter((file) => file.endsWith(".gguf"));
	if (candidates.length !== 1 || candidates[0] !== "silero-vad-v5.gguf")
		throw Error("Ambiguous speech VAD model");
	const ffi = loadElizaInferenceFfi(library);
	try {
		if (
			Number(ffi.libraryAbiVersion) < 17 ||
			!ffi.asrSupported?.() ||
			!ffi.asrCancel ||
			!ffi.vadSupported?.() ||
			!ffi.vadOpen ||
			!ffi.vadProcess ||
			!ffi.vadReset ||
			!ffi.vadClose
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
		const { vadOpen, vadProcess, vadReset, vadClose } = ffi;
		if (!vadOpen || !vadProcess || !vadReset || !vadClose) {
			ffi.close();
			throw Error("Unsupported speech VAD ABI");
		}
		const ctx = ffi.create(root);
		let acquired = false;
		let vad: NativeVadHandle | undefined;
		const acquire = () => {
			if (acquired) return;
			ffi.mmapAcquire(ctx, "asr");
			vad = vadOpen({ ctx, sampleRateHz: 16000 });
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
				if (vad === undefined) throw Error("Speech VAD is not initialized");
				vadReset(vad);
				const vadPcm = resampleLinear(pcm, request.sampleRate, 16000);
				let speech = false;
				for (let offset = 0; offset < vadPcm.length; offset += 512) {
					const window = new Float32Array(512);
					window.set(vadPcm.subarray(offset, offset + 512));
					const probability = vadProcess({ vad, pcm: window });
					if (
						!Number.isFinite(probability) ||
						probability < 0 ||
						probability > 1
					)
						throw Error("Invalid speech VAD result");
					if (probability >= 0.5) {
						speech = true;
						break;
					}
				}
				// VAD decides admission only; ASR receives the entire original audio.
				if (!speech) return { text: "" };
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
				if (vad !== undefined) vadClose(vad);
				vad = undefined;
				ffi.mmapEvict(ctx, "asr");
			},
			dispose() {
				if (vad !== undefined) vadClose(vad);
				ffi.destroy(ctx);
				ffi.close();
			},
		};
	});
}
