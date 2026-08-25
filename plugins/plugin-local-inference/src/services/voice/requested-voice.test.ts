import { describe, expect, it } from "vitest";

import {
	extractRequestedKokoroVoiceId,
	extractRequestedVoiceId,
} from "./requested-voice";

describe("extractRequestedVoiceId", () => {
	it("returns undefined for a plain string", () => {
		expect(extractRequestedVoiceId("nova")).toBeUndefined();
	});

	it("returns undefined for null and non-objects", () => {
		expect(extractRequestedVoiceId(null)).toBeUndefined();
		expect(extractRequestedVoiceId(undefined)).toBeUndefined();
		expect(extractRequestedVoiceId(42)).toBeUndefined();
	});

	it("reads the explicit voice string", () => {
		expect(extractRequestedVoiceId({ voice: "af_bella" })).toBe("af_bella");
	});

	it("trims surrounding whitespace", () => {
		expect(extractRequestedVoiceId({ voice: "  af_bella  " })).toBe("af_bella");
	});

	it("returns undefined for an all-whitespace voice", () => {
		expect(extractRequestedVoiceId({ voice: "   " })).toBeUndefined();
	});

	it("returns undefined for an empty voice string", () => {
		expect(extractRequestedVoiceId({ voice: "" })).toBeUndefined();
	});

	it("falls back to the legacy voiceId spelling", () => {
		expect(extractRequestedVoiceId({ voiceId: "af_bella" })).toBe("af_bella");
	});

	it("prefers voice over the legacy voiceId spelling", () => {
		expect(
			extractRequestedVoiceId({ voice: "af_nicole", voiceId: "af_bella" }),
		).toBe("af_nicole");
	});

	it("ignores a non-string legacy voiceId", () => {
		expect(extractRequestedVoiceId({ voiceId: 7 })).toBeUndefined();
	});

	it("does not fall back to voiceId when voice is present but empty", () => {
		expect(extractRequestedVoiceId({ voice: "", voiceId: "af_bella" })).toBe(
			undefined,
		);
	});

	it("trims the legacy voiceId too", () => {
		expect(extractRequestedVoiceId({ voiceId: "  af_bella  " })).toBe(
			"af_bella",
		);
	});
});

describe("extractRequestedKokoroVoiceId", () => {
	it("returns undefined when no voice is requested", () => {
		expect(extractRequestedKokoroVoiceId({})).toBeUndefined();
		expect(extractRequestedKokoroVoiceId("nova")).toBeUndefined();
	});

	it("maps historical Piper names to bundled Kokoro ids", () => {
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

	it("maps OpenAI-era voice names case-insensitively", () => {
		expect(extractRequestedKokoroVoiceId({ voice: "nova" })).toBe("af_nova");
		expect(extractRequestedKokoroVoiceId({ voice: "NOVA" })).toBe("af_nova");
		expect(extractRequestedKokoroVoiceId({ voice: "Alloy" })).toBe("af_alloy");
	});

	it("maps aliases after trimming", () => {
		expect(extractRequestedKokoroVoiceId({ voice: "  nova  " })).toBe(
			"af_nova",
		);
	});

	it("passes unknown voice ids through unchanged", () => {
		expect(extractRequestedKokoroVoiceId({ voice: "af_custom" })).toBe(
			"af_custom",
		);
	});

	it("preserves the original casing of unknown voice ids", () => {
		expect(extractRequestedKokoroVoiceId({ voice: "MyCustomVoice" })).toBe(
			"MyCustomVoice",
		);
	});

	it("resolves legacy voiceId through the alias table", () => {
		expect(extractRequestedKokoroVoiceId({ voiceId: "nova" })).toBe("af_nova");
	});
});
