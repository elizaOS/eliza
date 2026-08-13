/**
 * Deterministic pure coverage for reusable global/sticky regex state during
 * action validation; no runtime, provider, or database harness is used.
 */
import { describe, expect, it } from "vitest";
import type { Memory } from "../types";
import { validateActionRegex } from "./keywords.ts";

const memory = (text?: string) => ({ content: { text } }) as Memory;

describe("validateActionRegex", () => {
	it("does not carry global lastIndex between repeated validations", () => {
		const regex = /hello/g;

		expect(validateActionRegex(memory("hello world"), [], regex)).toBe(true);
		expect(validateActionRegex(memory("hello world"), [], regex)).toBe(true);
		expect(regex.lastIndex).toBe(0);
	});

	it("does not carry sticky lastIndex between repeated validations", () => {
		const regex = /hello/y;

		expect(validateActionRegex(memory("hello world"), [], regex)).toBe(true);
		expect(validateActionRegex(memory("hello world"), [], regex)).toBe(true);
		expect(regex.lastIndex).toBe(0);
	});

	it("preserves ordinary expression matching and recent-message search", () => {
		expect(
			validateActionRegex(
				memory("current"),
				[memory("connect Discord")],
				/discord/i,
			),
		).toBe(true);
		expect(validateActionRegex(memory("current"), [], /slack/)).toBe(false);
	});
});
