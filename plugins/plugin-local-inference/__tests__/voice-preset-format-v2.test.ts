/**
 * Format-level tests for ELZ2 v2 voice presets (the OmniVoice freeze
 * artifact shape). Covers:
 *   - v1 round-trip stays bit-for-bit identical (back-compat).
 *   - v2 round-trip with non-empty refAudioTokens + refText + instruct +
 *     metadata.
 *   - v2 instruct-only path (empty refAudioTokens).
 *   - v2 → v1 transparency: a v2 file with version=2 reads back as v2,
 *     and the v2-only fields default to their empty equivalents on v1.
 *   - bad K/refT shape rejected by the writer.
 *   - corrupted header bytes rejected by the reader.
 *   - the v1 vs v2 header-size discriminator works (a v2 file truncated
 *     to v1 header size is rejected; a v1 file is accepted).
 */

import { describe, expect, it } from "vitest";
import {
	readVoicePresetFile,
	VOICE_PRESET_HEADER_BYTES_V1,
	VOICE_PRESET_HEADER_BYTES_V2,
	VOICE_PRESET_MAGIC,
	VOICE_PRESET_VERSION_V1,
	VOICE_PRESET_VERSION_V2,
	VoicePresetFormatError,
	writeVoicePresetFile,
	writeVoicePresetFileV2,
} from "../src/services/voice/voice-preset-format";

describe("voice-preset-format v2", () => {
	it("writes + reads a v1 file with embedding + phrases", () => {
		const embedding = new Float32Array([1, 2, 3, 4, 5]);
		const phrases = [
			{
				text: "hello world",
				sampleRate: 24000,
				pcm: new Float32Array([0.1, 0.2, 0.3]),
			},
		];
		const bytes = writeVoicePresetFile({ embedding, phrases });
		const parsed = readVoicePresetFile(bytes);
		expect(parsed.version).toBe(VOICE_PRESET_VERSION_V1);
		expect(Array.from(parsed.embedding)).toEqual(Array.from(embedding));
		expect(parsed.phrases).toHaveLength(1);
		expect(parsed.phrases[0].text).toBe("hello world");
		expect(parsed.refAudioTokens.K).toBe(0);
		expect(parsed.refAudioTokens.refT).toBe(0);
		expect(parsed.refAudioTokens.tokens.length).toBe(0);
		expect(parsed.refText).toBe("");
		expect(parsed.instruct).toBe("");
		expect(parsed.metadata).toEqual({});
	});

	it("writes + reads a full v2 file with refAudioTokens + refText + instruct + metadata", () => {
		const K = 8;
		const refT = 16;
		const tokens = new Int32Array(K * refT);
		for (let i = 0; i < tokens.length; i++) tokens[i] = i + 1;
		const refText = "Yeah, I've been trying to figure out how to talk to you.";
		const instruct = "young adult female, warm, soft, neutral us-american";
		const metadata = {
			voiceId: "sam",
			generator: "freeze-voice.mjs",
			referenceClipIds: ["same_001", "same_003"],
			referenceSeconds: 13.48,
		};
		const bytes = writeVoicePresetFileV2({
			refAudioTokens: { K, refT, tokens },
			refText,
			instruct,
			metadata,
		});
		const parsed = readVoicePresetFile(bytes);
		expect(parsed.version).toBe(VOICE_PRESET_VERSION_V2);
		expect(parsed.refAudioTokens.K).toBe(K);
		expect(parsed.refAudioTokens.refT).toBe(refT);
		expect(parsed.refAudioTokens.tokens.length).toBe(K * refT);
		for (let i = 0; i < tokens.length; i++) {
			expect(parsed.refAudioTokens.tokens[i]).toBe(tokens[i]);
		}
		expect(parsed.refText).toBe(refText);
		expect(parsed.instruct).toBe(instruct);
		expect(parsed.metadata.voiceId).toBe("sam");
		expect(parsed.metadata.referenceSeconds).toBe(13.48);
	});

	it("writes + reads a v2 instruct-only preset (no refAudioTokens)", () => {
		const bytes = writeVoicePresetFileV2({
			refText: "fallback transcript",
			instruct: "female, young adult, american accent",
		});
		const parsed = readVoicePresetFile(bytes);
		expect(parsed.version).toBe(VOICE_PRESET_VERSION_V2);
		expect(parsed.refAudioTokens.K).toBe(0);
		expect(parsed.refAudioTokens.refT).toBe(0);
		expect(parsed.refAudioTokens.tokens.length).toBe(0);
		expect(parsed.instruct).toBe("female, young adult, american accent");
		expect(parsed.refText).toBe("fallback transcript");
	});

	it("rejects refAudioTokens with shape mismatch", () => {
		const K = 8;
		const refT = 16;
		const tokens = new Int32Array(K * refT - 1); // one off
		expect(() =>
			writeVoicePresetFileV2({
				refAudioTokens: { K, refT, tokens },
			}),
		).toThrowError(VoicePresetFormatError);
	});

	it("rejects bad magic on read", () => {
		const buf = new Uint8Array(64);
		// magic = 'XXXX'
		buf[0] = 0x58;
		buf[1] = 0x58;
		buf[2] = 0x58;
		buf[3] = 0x58;
		buf[4] = 2; // version
		expect(() => readVoicePresetFile(buf)).toThrowError(VoicePresetFormatError);
	});

	it("rejects unsupported version", () => {
		const buf = new Uint8Array(VOICE_PRESET_HEADER_BYTES_V2);
		const view = new DataView(buf.buffer);
		view.setUint32(0, VOICE_PRESET_MAGIC, true);
		view.setUint32(4, 99, true); // unsupported version
		expect(() => readVoicePresetFile(buf)).toThrowError(VoicePresetFormatError);
	});

	it("rejects truncated v2 header", () => {
		const buf = new Uint8Array(VOICE_PRESET_HEADER_BYTES_V1); // too small for v2
		const view = new DataView(buf.buffer);
		view.setUint32(0, VOICE_PRESET_MAGIC, true);
		view.setUint32(4, VOICE_PRESET_VERSION_V2, true);
		expect(() => readVoicePresetFile(buf)).toThrowError(VoicePresetFormatError);
	});

	it("writer produces a header that the reader's v2 discriminator accepts", () => {
		const bytes = writeVoicePresetFileV2({
			refText: "hello",
			instruct: "female",
		});
		// The first 4 bytes are 'ELZ1', then version=2.
		const view = new DataView(bytes.buffer);
		expect(view.getUint32(0, true)).toBe(VOICE_PRESET_MAGIC);
		expect(view.getUint32(4, true)).toBe(VOICE_PRESET_VERSION_V2);
		// reserved words at +56/+60 must be 0
		expect(view.getUint32(56, true)).toBe(0);
		expect(view.getUint32(60, true)).toBe(0);
	});

	it("rejects non-zero reserved words on read (forward-compat guard)", () => {
		const bytes = writeVoicePresetFileV2({ instruct: "female" });
		const buf = new Uint8Array(bytes);
		const view = new DataView(buf.buffer);
		view.setUint32(56, 1, true); // reserved word set
		expect(() => readVoicePresetFile(buf)).toThrowError(VoicePresetFormatError);
	});
});
