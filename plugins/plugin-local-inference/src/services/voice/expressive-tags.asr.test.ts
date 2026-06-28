/**
 * Unit coverage for the ASR-emotion → expressive-tag helpers (#9147 voice).
 *
 * normalizeAsrEmotionLabel / asrEmotionToTag / expressiveTagPromptClause are
 * pure mappers between local ASR emotion labels and the TTS expressive-tag
 * vocabulary; they were untested (the parse/strip helpers in the same file are
 * covered separately). No GGUF / audio.
 */

import { describe, expect, it } from "vitest";
import {
	asrEmotionToTag,
	EXPRESSIVE_EMOTION_TAGS,
	EXPRESSIVE_NONVERBAL_TAGS,
	EXPRESSIVE_SINGING_TAG,
	expressiveTagPromptClause,
	normalizeAsrEmotionLabel,
} from "./expressive-tags";

describe("normalizeAsrEmotionLabel", () => {
	it("returns null for empty/missing input", () => {
		expect(normalizeAsrEmotionLabel(null)).toBeNull();
		expect(normalizeAsrEmotionLabel(undefined)).toBeNull();
		expect(normalizeAsrEmotionLabel("")).toBeNull();
	});

	it("passes through a canonical noun label (case/space-insensitive)", () => {
		expect(normalizeAsrEmotionLabel("happiness")).toBe("happiness");
		expect(normalizeAsrEmotionLabel("  HAPPINESS ")).toBe("happiness");
	});

	it("maps common adjective forms to noun labels", () => {
		expect(normalizeAsrEmotionLabel("happy")).toBe("happiness");
		expect(normalizeAsrEmotionLabel("sad")).toBe("sadness");
		expect(normalizeAsrEmotionLabel("angry")).toBe("anger");
		expect(normalizeAsrEmotionLabel("afraid")).toBe("fear");
		expect(normalizeAsrEmotionLabel("scared")).toBe("fear");
		expect(normalizeAsrEmotionLabel("surprised")).toBe("surprise");
		expect(normalizeAsrEmotionLabel("disgusted")).toBe("disgust");
	});

	it("returns null for an unknown label", () => {
		expect(normalizeAsrEmotionLabel("gibberish-xyz")).toBeNull();
	});
});

describe("asrEmotionToTag", () => {
	it("maps a recognized emotion to an expressive emotion tag", () => {
		const tag = asrEmotionToTag("happy");
		expect(tag).not.toBeNull();
		expect(EXPRESSIVE_EMOTION_TAGS).toContain(tag);
	});

	it("returns null for null / unknown input", () => {
		expect(asrEmotionToTag(null)).toBeNull();
		expect(asrEmotionToTag("gibberish-xyz")).toBeNull();
	});
});

describe("expressiveTagPromptClause", () => {
	it("lists the emotion + nonverbal tags and excludes singing by default", () => {
		const clause = expressiveTagPromptClause();
		for (const tag of EXPRESSIVE_EMOTION_TAGS) {
			expect(clause).toContain(`[${tag}]`);
		}
		for (const tag of EXPRESSIVE_NONVERBAL_TAGS) {
			expect(clause).toContain(`[${tag}]`);
		}
		expect(clause).not.toContain(`[${EXPRESSIVE_SINGING_TAG}]`);
	});

	it("includes the singing tag only when singingAllowed", () => {
		expect(expressiveTagPromptClause({ singingAllowed: true })).toContain(
			`[${EXPRESSIVE_SINGING_TAG}]`,
		);
	});
});
