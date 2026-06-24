// Round-trip coverage for the voice-preset binary (de)serializer. The format is
// the on-disk shape for enrolled TTS voice presets, and readVoicePresetFile is
// "the single defensive boundary for the format" — so we pin that a written
// preset reads back byte-for-byte (v1 + v2) and that malformed input throws.

import { describe, expect, it } from "vitest";
import {
	readVoicePresetFile,
	VOICE_PRESET_VERSION_V1,
	VOICE_PRESET_VERSION_V2,
	VoicePresetFormatError,
	writeVoicePresetFile,
	writeVoicePresetFileV2,
} from "./voice-preset-format";

// Values chosen to be exactly representable in float32 so the round-trip is
// bit-exact (no rounding to reason about).
const embedding = new Float32Array([0.5, -0.25, 0.75, -1]);
const phrases = [
	{
		text: "hello there",
		sampleRate: 24000,
		pcm: new Float32Array([0.5, -0.5]),
	},
	{ text: "", sampleRate: 16000, pcm: new Float32Array([0.25]) },
];

describe("voice-preset-format round-trip", () => {
	it("writes and reads back a v1 preset (embedding + phrases)", () => {
		const parsed = readVoicePresetFile(
			writeVoicePresetFile({ embedding, phrases }),
		);
		expect(parsed.version).toBe(VOICE_PRESET_VERSION_V1);
		expect(Array.from(parsed.embedding)).toEqual(Array.from(embedding));
		expect(parsed.phrases).toHaveLength(2);
		expect(parsed.phrases[0].text).toBe("hello there");
		expect(parsed.phrases[0].sampleRate).toBe(24000);
		expect(Array.from(parsed.phrases[0].pcm)).toEqual([0.5, -0.5]);
		expect(parsed.phrases[1].text).toBe("");
	});

	it("writes and reads back a v2 preset (refText/instruct/metadata/tokens)", () => {
		const parsed = readVoicePresetFile(
			writeVoicePresetFileV2({
				embedding,
				phrases,
				refText: "reference line",
				instruct: "speak warmly",
				metadata: { voiceId: "af_bella", lang: "en" },
				refAudioTokens: { K: 2, refT: 2, tokens: new Int32Array([1, 2, 3, 4]) },
			}),
		);
		expect(parsed.version).toBe(VOICE_PRESET_VERSION_V2);
		expect(Array.from(parsed.embedding)).toEqual(Array.from(embedding));
		expect(parsed.refText).toBe("reference line");
		expect(parsed.instruct).toBe("speak warmly");
		expect(parsed.metadata).toEqual({ voiceId: "af_bella", lang: "en" });
		expect(parsed.refAudioTokens.K).toBe(2);
		expect(Array.from(parsed.refAudioTokens.tokens)).toEqual([1, 2, 3, 4]);
	});

	it("rejects a ref_audio_tokens shape mismatch", () => {
		expect(() =>
			writeVoicePresetFileV2({
				refAudioTokens: { K: 2, refT: 2, tokens: new Int32Array([1, 2, 3]) },
			}),
		).toThrow(VoicePresetFormatError);
	});

	it("throws on a malformed blob (the single defensive boundary)", () => {
		expect(() => readVoicePresetFile(new Uint8Array([1, 2, 3, 4]))).toThrow(
			VoicePresetFormatError,
		);
	});
});
