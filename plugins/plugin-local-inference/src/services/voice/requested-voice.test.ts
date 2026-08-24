/**
 * Unit coverage for requested-voice — TTS voice identifier extraction and
 * Kokoro alias resolution.
 *
 * Behavioral risk: a malformed `voice`/`voiceId` (whitespace-only, wrong
 * type, null) silently becomes `undefined`, which would make the TTS engine
 * fall back to a default voice or reject the request; alias resolution must
 * be case-insensitive and must never rewrite an unknown voice id.
 */
import { describe, expect, it } from "vitest";
import {
	extractRequestedKokoroVoiceId,
	extractRequestedVoiceId,
} from "./requested-voice.ts";

describe("extractRequestedVoiceId", () => {
	it("returns undefined for non-object params", () => {
		expect(extractRequestedVoiceId("nova")).toBeUndefined();
		expect(extractRequestedVoiceId(null)).toBeUndefined();
		expect(extractRequestedVoiceId(undefined)).toBeUndefined();
		expect(extractRequestedVoiceId(42 as never)).toBeUndefined();
	});

	it("reads the explicit voice string", () => {
		expect(extractRequestedVoiceId({ voice: "af_bella" })).toBe("af_bella");
	});

	it("trims surrounding whitespace from voice", () => {
		expect(extractRequestedVoiceId({ voice: "  af_bella  " })).toBe("af_bella");
	});

	it("returns undefined when voice is whitespace-only", () => {
		expect(extractRequestedVoiceId({ voice: "   " })).toBeUndefined();
		expect(extractRequestedVoiceId({ voice: "\t\n" })).toBeUndefined();
	});

	it("falls back to the legacy voiceId spelling", () => {
		expect(extractRequestedVoiceId({ voiceId: "en_us-female" })).toBe(
			"en_us-female",
		);
	});

	it("prefers voice over voiceId", () => {
		expect(
			extractRequestedVoiceId({ voice: "af_bella", voiceId: "alloy" }),
		).toBe("af_bella");
	});

	it("uses voiceId when voice is present but not a string", () => {
		expect(
			extractRequestedVoiceId({ voice: 42 as never, voiceId: "nova" }),
		).toBe("nova");
	});

	it("ignores non-string voiceId", () => {
		expect(extractRequestedVoiceId({ voiceId: 42 as never })).toBeUndefined();
	});
});

describe("extractRequestedKokoroVoiceId", () => {
	it("returns undefined when nothing is requested", () => {
		expect(extractRequestedKokoroVoiceId({})).toBeUndefined();
		expect(extractRequestedKokoroVoiceId("nova")).toBeUndefined();
	});

	it("maps historical Piper voices to bundled Kokoro ids", () => {
		expect(
			extractRequestedKokoroVoiceId({ voice: "en_us-female-medium" }),
		).toBe("af_nicole");
		expect(extractRequestedKokoroVoiceId({ voice: "en_us-female" })).toBe(
			"af_bella",
		);
		expect(extractRequestedKokoroVoiceId({ voice: "en_us-male-medium" })).toBe(
			"am_michael",
		);
	});

	it("maps OpenAI-style aliases case-insensitively", () => {
		expect(extractRequestedKokoroVoiceId({ voice: "nova" })).toBe("af_nova");
		expect(extractRequestedKokoroVoiceId({ voice: "NOVA" })).toBe("af_nova");
		expect(extractRequestedKokoroVoiceId({ voice: "Alloy" })).toBe("af_alloy");
	});

	it("passes through unknown voice ids unchanged", () => {
		expect(extractRequestedKokoroVoiceId({ voice: "af_heart" })).toBe(
			"af_heart",
		);
		expect(extractRequestedKokoroVoiceId({ voiceId: "custom-voice" })).toBe(
			"custom-voice",
		);
	});

	it("applies alias mapping to the legacy voiceId spelling too", () => {
		expect(extractRequestedKokoroVoiceId({ voiceId: "en_us-female" })).toBe(
			"af_bella",
		);
	});
});
