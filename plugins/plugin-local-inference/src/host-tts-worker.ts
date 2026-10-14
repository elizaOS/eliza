/**
 * Explicit host-only Paradee-8M TTS worker on libelizainference (ABI v17).
 * Protocol uses fd 3; diagnostics never reach callers.
 *
 * Environment: ELIZA_INFERENCE_LIBRARY + ELIZA_INFERENCE_LIBRARY_SHA256, and an
 * absolute ELIZA_PARADEE_MODEL_DIR holding the pinned `paradee-8m-v1_0.gguf`
 * and `misaki-en-us.lex`. Text is phonemized by the native misaki G2P; no
 * ONNX, no host phonemizer, no download and no cloud fallback.
 *
 * Requests: `{id, op:"synthesize", text}` returns `{id, audio}` (base64 mono
 * PCM16 WAV at 24 kHz) or `{id, error}`. `{op:"cancel", id}` calls
 * `eliza_inference_cancel_tts` for the request in flight.
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
 * Paradee-8M v1.0 GGUF converted from sahilmahendrakar/Paradee-8M-v1.0 and the
 * misaki en-US lexicon, as recorded by `tools/paradee/pins.json` and
 * `tools/misaki-g2p/pins.json` in the pinned llama.cpp fork.
 */
export const PARADEE_ASSETS: readonly PinnedSpeechAsset[] = [
	{
		path: "paradee-8m-v1_0.gguf",
		sha256: "c0a1c54d0c5e065525f93e677e77a6b7ebc5fa523ccf0a494050e472ffa08a54",
		bytes: 32_072_768,
	},
	{
		path: "misaki-en-us.lex",
		sha256: "fbf09090cff0a41f3f579bf03ab9fc42710b04d7284767b10467a5f182c23925",
		bytes: 12_947_790,
	},
];
const SAMPLE_RATE = 24000;
const MAX_SECONDS = 60;

interface SynthesisRequest {
	id: string;
	text: string;
}

function wav(pcm: Float32Array): string {
	if (!pcm.length) throw Error("No speech audio");
	if (pcm.length > MAX_SECONDS * SAMPLE_RATE)
		throw Error("Speech exceeds duration limit");
	const audio = Buffer.alloc(44 + pcm.length * 2);
	audio.write("RIFF");
	audio.writeUInt32LE(audio.length - 8, 4);
	audio.write("WAVE", 8);
	audio.write("fmt ", 12);
	audio.writeUInt32LE(16, 16);
	audio.writeUInt16LE(1, 20);
	audio.writeUInt16LE(1, 22);
	audio.writeUInt32LE(SAMPLE_RATE, 24);
	audio.writeUInt32LE(SAMPLE_RATE * 2, 28);
	audio.writeUInt16LE(2, 32);
	audio.writeUInt16LE(16, 34);
	audio.write("data", 36);
	audio.writeUInt32LE(pcm.length * 2, 40);
	for (let i = 0; i < pcm.length; i++) {
		const sample = pcm[i] as number;
		if (!Number.isFinite(sample)) throw Error("Invalid speech sample");
		const value = Math.max(-1, Math.min(1, sample));
		audio.writeInt16LE(
			Math.round(value * (value < 0 ? 32768 : 32767)),
			44 + i * 2,
		);
	}
	return audio.toString("base64");
}

// The engine thread runs in this process after the protocol thread verified
// the library and assets, so it does not hash them again.
const library = isMainThread
	? verifiedInferenceLibrary()
	: process.env.ELIZA_INFERENCE_LIBRARY || "";
const root = process.env.ELIZA_PARADEE_MODEL_DIR || "";

if (isMainThread) {
	verifyPinnedAssets(root, PARADEE_ASSETS);
	const ffi = loadElizaInferenceFfi(library);
	try {
		if (Number(ffi.libraryAbiVersion) < 17 || !ffi.paradeeSupported?.())
			throw Error("Unsupported speech ABI");
		await serveSpeechProtocol<SynthesisRequest>({
			engineUrl: new URL(import.meta.url),
			maxLine: 8192,
			idleReleaseMs: 120_000,
			parse(input) {
				if (
					input.op !== "synthesize" ||
					typeof input.text !== "string" ||
					!input.text.trim() ||
					input.text.length > 500
				)
					throw Error("Invalid speech request");
				return { id: input.id as string, text: input.text };
			},
			cancel: (ctx) => ffi.cancelTts(ctx),
		});
	} finally {
		ffi.close();
	}
} else {
	serveSpeechEngine<SynthesisRequest>(() => {
		const ffi = loadElizaInferenceFfi(library);
		const ctx = ffi.create(root);
		const synthesize = (text: string) => {
			const result = ffi.paradeeSynthesize?.({ ctx, text, speed: 1 });
			if (!result || result.cancelled) throw Error("Speech cancelled");
			return wav(result.pcm);
		};
		try {
			ffi.paradeeLoad?.({
				ctx,
				ggufPath: `${root}/${PARADEE_ASSETS[0]?.path}`,
				lexiconPath: `${root}/${PARADEE_ASSETS[1]?.path}`,
			});
			if (ffi.paradeeSampleRate?.(ctx) !== SAMPLE_RATE)
				throw Error("Invalid speech sample rate");
			synthesize("Ready.");
		} catch (error) {
			ffi.destroy(ctx);
			ffi.close();
			throw error;
		}
		return {
			ctx,
			run: (request) => ({ audio: synthesize(request.text) }),
			release: () => ffi.mmapEvict(ctx, "tts"),
			dispose() {
				ffi.destroy(ctx);
				ffi.close();
			},
		};
	});
}
