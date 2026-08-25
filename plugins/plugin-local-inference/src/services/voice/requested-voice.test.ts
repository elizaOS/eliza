/**
 * Unit tests for `requested-voice`: validates normalization of voice parameter
 * inputs across canonical `voice` and legacy `voiceId` properties, whitespace
 * trimming, and Kokoro alias translation for historical Piper and OpenAI voice ids.
 */
import type { TextToSpeechParams } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	extractRequestedKokoroVoiceId,
	extractRequestedVoiceId,
} from "./requested-voice.ts";

describe("requested-voice", () => {
	describe("extractRequestedVoiceId", () => {
		it("returns undefined for string inputs or non-object primitives", () => {
			expect(extractRequestedVoiceId("hello world")).toBeUndefined();
			expect(
				extractRequestedVoiceId(null as unknown as TextToSpeechParams),
			).toBeUndefined();
			expect(
				extractRequestedVoiceId(undefined as unknown as TextToSpeechParams),
			).toBeUndefined();
		});

		it("extracts explicit voice parameter from object", () => {
			expect(extractRequestedVoiceId({ text: "hi", voice: "af_bella" })).toBe(
				"af_bella",
			);
		});

		it("extracts legacy voiceId when voice is not specified", () => {
			expect(
				extractRequestedVoiceId({
					text: "hi",
					voiceId: "en_us-male-medium",
				} as unknown as TextToSpeechParams),
			).toBe("en_us-male-medium");
		});

		it("prioritizes canonical voice over legacy voiceId when both exist", () => {
			expect(
				extractRequestedVoiceId({
					text: "hi",
					voice: "af_nicole",
					voiceId: "en_us-male-medium",
				} as unknown as TextToSpeechParams),
			).toBe("af_nicole");
		});

		it("trims whitespace from voice string and ignores empty whitespace-only values", () => {
			expect(
				extractRequestedVoiceId({ text: "hi", voice: "  af_sarah  " }),
			).toBe("af_sarah");
			expect(
				extractRequestedVoiceId({ text: "hi", voice: "   \t\n  " }),
			).toBeUndefined();
			expect(
				extractRequestedVoiceId({
					text: "hi",
					voiceId: "   ",
				} as unknown as TextToSpeechParams),
			).toBeUndefined();
		});

		it("ignores non-string voice or voiceId fields", () => {
			expect(
				extractRequestedVoiceId({
					text: "hi",
					voice: 12345,
				} as unknown as TextToSpeechParams),
			).toBeUndefined();
			expect(
				extractRequestedVoiceId({
					text: "hi",
					voiceId: { id: "voice" },
				} as unknown as TextToSpeechParams),
			).toBeUndefined();
		});
	});

	describe("extractRequestedKokoroVoiceId", () => {
		it("returns undefined when no voice is requested", () => {
			expect(extractRequestedKokoroVoiceId("raw text")).toBeUndefined();
			expect(extractRequestedKokoroVoiceId({ text: "hi" })).toBeUndefined();
			expect(
				extractRequestedKokoroVoiceId({ text: "hi", voice: "   " }),
			).toBeUndefined();
		});

		it.each([
			["en_us-female-medium", "af_nicole"],
			["EN_US-FEMALE-MEDIUM", "af_nicole"],
			["en_us-female", "af_bella"],
			["En_Us-Female", "af_bella"],
			["en_us-male-medium", "am_michael"],
			["EN_US-MALE-MEDIUM", "am_michael"],
			["nova", "af_nova"],
			["NOVA", "af_nova"],
			["Nova", "af_nova"],
			["alloy", "af_alloy"],
			["ALLOY", "af_alloy"],
			["Alloy", "af_alloy"],
		])("maps alias %s to canonical Kokoro voice %s", (alias, expected) => {
			expect(extractRequestedKokoroVoiceId({ text: "hi", voice: alias })).toBe(
				expected,
			);
			expect(
				extractRequestedKokoroVoiceId({
					text: "hi",
					voiceId: alias,
				} as unknown as TextToSpeechParams),
			).toBe(expected);
		});

		it("preserves unaliased native Kokoro voice identifiers without modification", () => {
			expect(
				extractRequestedKokoroVoiceId({ text: "hi", voice: "af_sky" }),
			).toBe("af_sky");
			expect(
				extractRequestedKokoroVoiceId({ text: "hi", voice: "am_adam" }),
			).toBe("am_adam");
			expect(
				extractRequestedKokoroVoiceId({ text: "hi", voice: "bf_emma" }),
			).toBe("bf_emma");
			expect(
				extractRequestedKokoroVoiceId({
					text: "hi",
					voiceId: "bm_george",
				} as unknown as TextToSpeechParams),
			).toBe("bm_george");
		});
	});
});
