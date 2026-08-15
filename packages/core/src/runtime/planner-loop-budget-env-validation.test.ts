/**
 * Pins the fail-fast contract for the planner's four operator-facing budget
 * env knobs (issue #19622): a set-but-non-canonical value throws a fatal typed
 * ElizaError naming the setting instead of silently coercing or falling back to
 * a default, while unset/empty preserves the historical default and a canonical
 * value keeps its exact configured meaning (no silent floor/truncation).
 * Deterministic parser test over the exported resolvers; no runtime boot.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ElizaError, isElizaError } from "../errors";
import {
	resolveCodingMaxRequiredToolMisses,
	resolveCodingMaxToolCalls,
	resolvePositivePlannerInt,
} from "./planner-loop";

// The full rejection matrix from the work order: malformed suffix, exponent,
// decimal, leading space, leading zero, negative, and the JS-truthy "Infinity"
// literal. None is a canonical positive decimal integer.
const REJECTED_VALUES = [
	"80oops",
	"1e2",
	"3.9",
	" 80",
	"080",
	"-5",
	"Infinity",
] as const;

describe("resolvePositivePlannerInt (planner budget env fail-fast)", () => {
	it("returns the default for an unset value", () => {
		expect(resolvePositivePlannerInt("ELIZA_TEST_BUDGET", undefined, 42)).toBe(
			42,
		);
	});

	it("returns the default for an empty string (preserving unset⇒default)", () => {
		expect(resolvePositivePlannerInt("ELIZA_TEST_BUDGET", "", 42)).toBe(42);
	});

	it("passes a canonical positive integer through with no floor/truncation", () => {
		expect(resolvePositivePlannerInt("ELIZA_TEST_BUDGET", "80", 42)).toBe(80);
		expect(resolvePositivePlannerInt("ELIZA_TEST_BUDGET", "16384", 42)).toBe(
			16384,
		);
		expect(resolvePositivePlannerInt("ELIZA_TEST_BUDGET", "1", 42)).toBe(1);
	});

	it.each(REJECTED_VALUES)(
		"throws a fatal ElizaError naming the setting for %j",
		(value) => {
			let thrown: unknown;
			try {
				resolvePositivePlannerInt("ELIZA_TEST_BUDGET", value, 42);
			} catch (error) {
				thrown = error;
			}
			expect(isElizaError(thrown)).toBe(true);
			const err = thrown as ElizaError;
			expect(err.code).toBe("PLANNER_BUDGET_ENV_INVALID");
			expect(err.severity).toBe("fatal");
			expect(err.message).toContain("ELIZA_TEST_BUDGET");
			expect(err.message).toContain(value);
			expect(err.context).toMatchObject({
				setting: "ELIZA_TEST_BUDGET",
				received: value,
			});
		},
	);

	it("rejects '0' (a positive integer knob cannot be zero)", () => {
		expect(() =>
			resolvePositivePlannerInt("ELIZA_TEST_BUDGET", "0", 42),
		).toThrow(ElizaError);
	});
});

describe("resolveCodingMaxToolCalls (ELIZA_CODING_MAX_TOOL_CALLS)", () => {
	const KEY = "ELIZA_CODING_MAX_TOOL_CALLS";
	let original: string | undefined;

	beforeEach(() => {
		original = process.env[KEY];
	});

	afterEach(() => {
		if (original === undefined) {
			delete process.env[KEY];
		} else {
			process.env[KEY] = original;
		}
	});

	it("defaults to 80 when unset", () => {
		delete process.env[KEY];
		expect(resolveCodingMaxToolCalls()).toBe(80);
	});

	it("honors a canonical override exactly", () => {
		process.env[KEY] = "120";
		expect(resolveCodingMaxToolCalls()).toBe(120);
	});

	it.each(REJECTED_VALUES)("throws for the malformed value %j", (value) => {
		process.env[KEY] = value;
		let thrown: unknown;
		try {
			resolveCodingMaxToolCalls();
		} catch (error) {
			thrown = error;
		}
		expect(isElizaError(thrown)).toBe(true);
		expect((thrown as ElizaError).message).toContain(KEY);
	});
});

describe("resolveCodingMaxRequiredToolMisses (ELIZA_CODING_MAX_REQUIRED_TOOL_MISSES)", () => {
	const KEY = "ELIZA_CODING_MAX_REQUIRED_TOOL_MISSES";
	let original: string | undefined;

	beforeEach(() => {
		original = process.env[KEY];
	});

	afterEach(() => {
		if (original === undefined) {
			delete process.env[KEY];
		} else {
			process.env[KEY] = original;
		}
	});

	it("defaults to 8 when unset", () => {
		delete process.env[KEY];
		expect(resolveCodingMaxRequiredToolMisses()).toBe(8);
	});

	it("honors a canonical override exactly", () => {
		process.env[KEY] = "16";
		expect(resolveCodingMaxRequiredToolMisses()).toBe(16);
	});

	it.each(REJECTED_VALUES)("throws for the malformed value %j", (value) => {
		process.env[KEY] = value;
		let thrown: unknown;
		try {
			resolveCodingMaxRequiredToolMisses();
		} catch (error) {
			thrown = error;
		}
		expect(isElizaError(thrown)).toBe(true);
		expect((thrown as ElizaError).message).toContain(KEY);
	});
});
