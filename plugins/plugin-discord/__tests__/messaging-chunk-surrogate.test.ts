/**
 * Regression tests for the outbound Discord `splitMessage` fallback
 * (`utils.ts`, used by the connector delivery and retry paths): a raw-limit
 * slice must never split a UTF-16 surrogate pair (emoji) across chunks, and a
 * chunk limit that cannot make UTF-16 progress must reject instead of
 * spinning. Pure-function assertions on the real exported `splitMessage`.
 */
import { describe, expect, it } from "vitest";
import { splitMessage } from "../utils";

const MAX_DISCORD_MESSAGE_LENGTH = 2000;

function expectWellFormedLossless(chunks: string[], original: string): void {
	expect(chunks.length).toBeGreaterThan(1);
	for (const chunk of chunks) {
		expect(chunk.length).toBeGreaterThan(0);
		expect(chunk.isWellFormed()).toBe(true);
	}
	expect(chunks.join("")).toBe(original);
}

describe("splitMessage surrogate-safe chunking", () => {
	it("keeps surrogate pairs intact and lossless across the limit", () => {
		// A leading single-width char shifts the emoji run onto an odd offset,
		// so the raw-limit fallback cut lands between a pair's high and low
		// surrogate instead of coincidentally on a pair boundary.
		const text = `b${"🎉".repeat(MAX_DISCORD_MESSAGE_LENGTH)}`;

		const chunks = splitMessage(text, MAX_DISCORD_MESSAGE_LENGTH);

		expectWellFormedLossless(chunks, text);
		for (const chunk of chunks) {
			expect(chunk.length).toBeLessThanOrEqual(MAX_DISCORD_MESSAGE_LENGTH);
		}
	});

	it("splits on whitespace when available and stays well-formed", () => {
		const firstLine = "y".repeat(MAX_DISCORD_MESSAGE_LENGTH - 1);
		const text = `${firstLine} z`;

		const chunks = splitMessage(text, MAX_DISCORD_MESSAGE_LENGTH);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.isWellFormed()).toBe(true);
		}
	});

	it("returns the original text unchanged when under the limit", () => {
		expect(splitMessage("hello world", MAX_DISCORD_MESSAGE_LENGTH)).toEqual([
			"hello world",
		]);
	});

	it("rejects a chunk limit that cannot make UTF-16 progress", () => {
		// maxLength=1 cannot hold the lead half of an emoji without stranding it.
		expect(() => splitMessage(`😀${"x".repeat(10)}`, 1)).toThrow(RangeError);
	});
});
