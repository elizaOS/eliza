/**
 * Prompt-batcher shared helpers. sanitizeIdentifier must yield a valid
 * identifier (prefix when it can't start with a letter/underscore); retry count
 * is clamped to 0..2; getSourceMessageId derives a stable per-platform dedup key
 * (so the same inbound message isn't batched twice); and rollingAverage folds a
 * new sample into a running mean.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../../types/memory";
import {
	clampRetryCount,
	getSourceMessageId,
	hasMeaningfulSectionDrift,
	pickFields,
	rollingAverage,
	sanitizeIdentifier,
} from "./shared.ts";

describe("sanitizeIdentifier", () => {
	it("replaces non-identifier chars and guarantees a valid leading char", () => {
		expect(sanitizeIdentifier("foo-bar.baz")).toBe("foo_bar_baz");
		expect(sanitizeIdentifier("123abc")).toBe("section_123abc"); // can't start with digit
		expect(sanitizeIdentifier("_ok")).toBe("_ok");
	});
});

describe("clampRetryCount", () => {
	it("clamps to 0..2 and floors, defaulting junk to 0", () => {
		expect(clampRetryCount(undefined)).toBe(0);
		expect(clampRetryCount(Number.NaN)).toBe(0);
		expect(clampRetryCount(-5)).toBe(0);
		expect(clampRetryCount(1.9)).toBe(1);
		expect(clampRetryCount(9)).toBe(2);
	});
});

describe("getSourceMessageId", () => {
	it("derives a stable per-platform id, falling back to internal:<id>", () => {
		expect(
			getSourceMessageId({
				metadata: { discordMessageId: "d1" },
				content: {},
			} as Memory),
		).toBe("discord:d1");
		expect(
			getSourceMessageId({
				metadata: {},
				content: { messageId: 77 },
			} as Memory),
		).toBe("telegram:77");
		expect(
			getSourceMessageId({
				metadata: { slack: { messageTs: "1.2" } },
				content: {},
			} as Memory),
		).toBe("slack:1.2");
		expect(
			getSourceMessageId({ id: "abc", metadata: {}, content: {} } as Memory),
		).toBe("internal:abc");
	});
});

describe("pickFields", () => {
	it("keeps only schema-declared fields that are present", () => {
		const picked = pickFields({ a: 1, b: 2, c: 3 }, [
			{ field: "a" },
			{ field: "c" },
		] as never);
		expect(picked).toEqual({ a: 1, c: 3 });
		expect(pickFields(null, [{ field: "a" }] as never)).toEqual({});
	});
});

describe("hasMeaningfulSectionDrift", () => {
	const section = (priority: number) =>
		({
			frequency: 1,
			providers: ["p"],
			preamble: "x",
			schema: [],
			priority,
			model: "m",
			affinityKey: "k",
		}) as never;

	it("detects a change in a comparable field, ignores identical sections", () => {
		expect(hasMeaningfulSectionDrift(section(1), section(1))).toBe(false);
		expect(hasMeaningfulSectionDrift(section(1), section(2))).toBe(true);
	});
});

describe("rollingAverage", () => {
	it("returns the new value for the first sample, else folds toward the mean", () => {
		expect(rollingAverage(0, 1, 10)).toBe(10);
		// running mean of [10, 20] computed incrementally on the 2nd sample.
		expect(rollingAverage(10, 2, 20)).toBe(15);
	});
});
