/** Surrogate safety for trajectory JSON string truncation: must never emit lone surrogates. */
import { describe, expect, test } from "vitest";
import {
	toWellFormedUnicode,
	truncateWellFormed,
} from "../utils/well-formed.ts";

const TRAJECTORY_JSON_MAX_STRING_CHARS = 64 * 1024;
const TRAJECTORY_JSON_TRUNCATION_SUFFIX = "...[truncated]";

function isWellFormed(value: string): boolean {
	if (!value) return true;
	const maybe = value as unknown as { isWellFormed?: () => boolean };
	if (typeof maybe.isWellFormed === "function") return maybe.isWellFormed();
	return toWellFormedUnicode(value) === value;
}

function truncateTrajectoryStringMock(value: string): string {
	const wellFormed = toWellFormedUnicode(value);
	if (wellFormed.length <= TRAJECTORY_JSON_MAX_STRING_CHARS) return wellFormed;
	const previewLength = Math.max(
		0,
		TRAJECTORY_JSON_MAX_STRING_CHARS - TRAJECTORY_JSON_TRUNCATION_SUFFIX.length,
	);
	return `${truncateWellFormed(wellFormed, previewLength)}${TRAJECTORY_JSON_TRUNCATION_SUFFIX}`;
}

describe("trajectory-json string surrogate safety", () => {
	const targetPreview =
		TRAJECTORY_JSON_MAX_STRING_CHARS - TRAJECTORY_JSON_TRUNCATION_SUFFIX.length;

	test("emoji at preview boundary backs off without lone surrogate", () => {
		const input = `${"a".repeat(targetPreview - 1)}🦊${"b".repeat(1000)}`;
		const out = truncateTrajectoryStringMock(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.endsWith(TRAJECTORY_JSON_TRUNCATION_SUFFIX)).toBe(true);
		expect(out.length).toBe(
			targetPreview - 1 + TRAJECTORY_JSON_TRUNCATION_SUFFIX.length,
		);
		expect(() => JSON.stringify({ trajectory: out })).not.toThrow();
	});

	test("fitting emoji ending at preview boundary kept intact", () => {
		const input = `${"a".repeat(targetPreview - 2)}🦊${"b".repeat(1000)}`;
		const out = truncateTrajectoryStringMock(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.endsWith(TRAJECTORY_JSON_TRUNCATION_SUFFIX)).toBe(true);
		expect(out.length).toBe(
			targetPreview + TRAJECTORY_JSON_TRUNCATION_SUFFIX.length,
		);
	});

	test("short trajectory string with emoji passes through untouched", () => {
		const input = "Trajectory step log with fox 🦊 emoji";
		const out = truncateTrajectoryStringMock(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out).toBe(input);
	});

	test("lone high surrogate is sanitized before truncation", () => {
		const input = `bad \ud800 surrogate ${"x".repeat(70000)}`;
		const out = truncateTrajectoryStringMock(input);
		expect(isWellFormed(out)).toBe(true);
		expect(out.includes("\ud800")).toBe(false);
		expect(out.endsWith(TRAJECTORY_JSON_TRUNCATION_SUFFIX)).toBe(true);
	});

	test("sweep offsets around 64KB cap all stay well-formed", () => {
		const fox = "🦊";
		for (let offset = -5; offset <= 5; offset++) {
			const n = targetPreview + offset;
			const input = `${"a".repeat(n)}${fox}${"b".repeat(1000)}`;
			const out = truncateTrajectoryStringMock(input);
			expect(isWellFormed(out)).toBe(true);
			expect(() => JSON.stringify({ trajectory: out })).not.toThrow();
		}
	});
});
