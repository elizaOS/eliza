/** Unit tests for parsing, detecting, and stripping expressive emotion tags in text. Deterministic. */
import { describe, expect, it } from "vitest";
import {
	emotionToEnum,
	enumToEmotion,
	isExpressiveEmotionEnum,
	isExpressiveTag,
	parseExpressiveTags,
	stripExpressiveTags,
} from "./expressive-tags.js";

/**
 * Inline expressive-tag parsing for the voice path (#9147). Tags are scoped:
 * an emotion/`[singing]` tag starts a new segment; `[laughter]`/`[sigh]` are
 * recorded non-verbals; unrecognized `[tokens]` are preserved as model text
 * (and flagged) rather than silently consumed.
 */

describe("isExpressiveTag / isExpressiveEmotionEnum", () => {
	it("recognizes vocabulary tags, case/space-insensitively", () => {
		expect(isExpressiveTag("happy")).toBe(true);
		expect(isExpressiveTag("  SINGING ")).toBe(true);
		expect(isExpressiveTag("laughter")).toBe(true);
		expect(isExpressiveTag("grumpy")).toBe(false);
	});

	it("treats none + emotions (but not singing) as enum values", () => {
		expect(isExpressiveEmotionEnum("none")).toBe(true);
		expect(isExpressiveEmotionEnum("excited")).toBe(true);
		expect(isExpressiveEmotionEnum("singing")).toBe(false);
		expect(isExpressiveEmotionEnum("grumpy")).toBe(false);
	});
});

describe("parseExpressiveTags", () => {
	it("returns one neutral segment for untagged text", () => {
		const parsed = parseExpressiveTags("just a normal reply");
		expect(parsed.hasTags).toBe(false);
		expect(parsed.dominantEmotion).toBeNull();
		expect(parsed.segments).toHaveLength(1);
		expect(parsed.segments[0]).toMatchObject({
			emotion: null,
			singing: false,
			cleanText: "just a normal reply",
		});
	});

	it("segments on each scope-setting emotion tag", () => {
		const parsed = parseExpressiveTags("[happy] hello [sad] world");
		expect(parsed.segments.map((s) => [s.emotion, s.cleanText])).toEqual([
			["happy", "hello"],
			["sad", "world"],
		]);
		expect(parsed.dominantEmotion).toBe("happy");
		expect(parsed.cleanText).toBe("hello world");
		expect(parsed.hasTags).toBe(true);
	});

	it("allows a mid-sentence shift with a leading neutral segment", () => {
		const parsed = parseExpressiveTags("that's [excited] amazing");
		expect(parsed.segments.map((s) => [s.emotion, s.cleanText])).toEqual([
			[null, "that's"],
			["excited", "amazing"],
		]);
		expect(parsed.dominantEmotion).toBe("excited");
	});

	it("tracks singing scope and preserves non-verbals without segmenting", () => {
		const singing = parseExpressiveTags("[singing] la la la");
		expect(singing.anySinging).toBe(true);
		expect(singing.segments[0]).toMatchObject({ singing: true, emotion: null });

		const nonverbal = parseExpressiveTags("hello [laughter] there");
		expect(nonverbal.segments).toHaveLength(1);
		expect(nonverbal.segments[0].nonverbals).toEqual(["laughter"]);
		expect(nonverbal.cleanText).toBe("hello there");
	});

	it("records unknown bracket tokens instead of treating them as tags", () => {
		const parsed = parseExpressiveTags("this is [grumpy] text");
		expect(parsed.unknownTags).toEqual(["[grumpy]"]);
		expect(parsed.hasTags).toBe(false);
		expect(parsed.cleanText).toBe("this is text");
	});
});

describe("stripExpressiveTags", () => {
	it("removes recognized tags but leaves unknown bracket tokens", () => {
		expect(stripExpressiveTags("[happy] hi [sigh] there")).toBe("hi there");
		expect(stripExpressiveTags("[grumpy] hi")).toBe("[grumpy] hi");
	});
});

describe("emotionToEnum / enumToEmotion", () => {
	it("round-trips an emotion and maps null ⇄ none", () => {
		expect(emotionToEnum("happy")).toBe("happy");
		expect(emotionToEnum(null)).toBe("none");
		expect(enumToEmotion("none")).toBeNull();
		expect(enumToEmotion("happy")).toBe("happy");
		expect(enumToEmotion("singing")).toBeNull();
		expect(enumToEmotion(undefined)).toBeNull();
	});
});
