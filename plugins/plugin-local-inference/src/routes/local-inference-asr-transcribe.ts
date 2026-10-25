import { type AgentRuntime, ModelType } from "@elizaos/core";
import { localInferenceEngine } from "../services/engine";
import { type AsrWordTiming, decodeMonoPcm16Wav } from "../services/voice";

/** A transcript plus optional per-word timings (ms from audio start). */
export interface LocalAsrTranscript {
	text: string;
	words: AsrWordTiming[];
}

/**
 * Providers the multi-platform `useModel` fallback tries in order. Exactly one
 * is registered per platform; the loop skips "no handler" providers and stops
 * at the first that answers. This path carries no word timings — the locked
 * `ModelType.TRANSCRIPTION ⇒ string` contract returns text only.
 */
const LOCAL_TRANSCRIPTION_PROVIDER_IDS = [
	"eliza-local-inference",
	"capacitor-llama",
	"eliza-device-bridge",
	"eliza-aosp-llama",
] as const;

function isMissingTranscriptionProviderError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/No handler found for delegate type: TRANSCRIPTION/.test(error.message)
	);
}

function normalizeTranscriptText(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (value && typeof value === "object") {
		const text = (value as { text?: unknown }).text;
		if (typeof text === "string") return text.trim();
	}
	throw new Error("TRANSCRIPTION returned an invalid transcript");
}

/**
 * Transcribe WAV audio to text + per-word timings.
 *
 * The primary path is the single fused libelizainference FFI pipe
 * (`transcribePcmTimed`, ASR ABI v12) — the cross-platform on-device runtime
 * that emits per-word `[startMs,endMs)` timings the transcript player
 * highlights against. When the in-process engine is not the active local
 * backend (a device-bridge / capacitor / AOSP topology owns transcription),
 * fall back to the `useModel` provider chain for the transcript text; word
 * timings are unavailable on that path (`words: []`).
 */
export async function transcribeWavWithWords(
	runtime: AgentRuntime,
	audioWav: Uint8Array,
	signal?: AbortSignal,
): Promise<LocalAsrTranscript> {
	if (await localInferenceEngine.available()) {
		const audio = decodeMonoPcm16Wav(audioWav);
		await localInferenceEngine.ensureActiveBundleAsrReady();
		const { text, words } = await localInferenceEngine.transcribePcmTimed(
			audio,
			signal,
		);
		return { text: text.trim(), words: [...words] };
	}
	return {
		text: await transcribeViaModelChain(runtime, audioWav, signal),
		words: [],
	};
}

async function transcribeViaModelChain(
	runtime: AgentRuntime,
	audio: Uint8Array,
	signal?: AbortSignal,
): Promise<string> {
	let lastError: unknown;
	for (const provider of LOCAL_TRANSCRIPTION_PROVIDER_IDS) {
		try {
			const transcript = normalizeTranscriptText(
				await runtime.useModel(
					ModelType.TRANSCRIPTION,
					{ audio, ...(signal ? { signal } : {}) } as never,
					provider,
				),
			);
			if (!transcript) {
				throw new Error("TRANSCRIPTION returned an empty transcript");
			}
			return transcript;
		} catch (err) {
			lastError = err;
			if (!isMissingTranscriptionProviderError(err)) throw err;
		}
	}
	if (lastError instanceof Error) throw lastError;
	throw new Error("No local-inference TRANSCRIPTION provider is registered");
}
