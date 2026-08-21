/**
 * Regression coverage for the production planner-limit Unicode boundaries.
 */

import { describe, expect, it } from "vitest";
import { toWellFormedUnicode } from "../utils/well-formed.ts";
import {
	countRepeatedFailures,
	type FailureLike,
	getFailureSignature,
} from "./limits.ts";

function errorPortion(error: string): string {
	const signature = getFailureSignature({ toolName: "X", error });
	if (signature === null) {
		throw new Error("Expected a failure signature");
	}
	return signature.slice(2);
}

function isWellFormed(text: string): boolean {
	const candidate = text as unknown as { isWellFormed?: () => boolean };
	if (typeof candidate.isWellFormed === "function") {
		return candidate.isWellFormed();
	}
	return toWellFormedUnicode(text) === text;
}

function failure(repeatKey: string): FailureLike {
	return {
		toolName: "WEB_FETCH",
		error: "ETIMEDOUT",
		success: false,
		repeatKey,
	};
}

describe("planner limit signatures stay well-formed", () => {
	it("backs off an astral character at the 240-code-unit error boundary", () => {
		const out = errorPortion(`${"a".repeat(239)}🦊${"b".repeat(20)}`);

		expect(out).toBe("a".repeat(239));
		expect(isWellFormed(out)).toBe(true);
	});

	it("preserves an astral character that fits the error boundary", () => {
		const input = `${"a".repeat(238)}🦊`;
		const out = errorPortion(input);

		expect(out).toBe(input);
		expect(out).toHaveLength(240);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes a pre-existing lone surrogate in the error", () => {
		const loneHighSurrogate = String.fromCharCode(0xd800);
		const out = errorPortion(`err ${loneHighSurrogate} text${"x".repeat(300)}`);

		expect(out).toContain("�");
		expect(out).not.toContain(loneHighSurrogate);
		expect(isWellFormed(out)).toBe(true);
	});

	it("normalizes astral repeat keys before comparing their bounded prefix", () => {
		const grinning = failure(`${"x".repeat(239)}😀-one`);
		const fox = failure(`${"x".repeat(239)}🦊-two`);

		expect(countRepeatedFailures([grinning, fox], grinning)).toBe(2);
	});

	it("normalizes lone surrogates in repeat keys before comparison", () => {
		const malformed = failure(`key-${String.fromCharCode(0xd800)}`);
		const repaired = failure("key-�");

		expect(countRepeatedFailures([malformed, repaired], repaired)).toBe(2);
	});
});
