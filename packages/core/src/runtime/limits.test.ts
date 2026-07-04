/**
 * Unit coverage for the planner runaway-loop guards (#8801 — these bound
 * worst-case cost/looping but shipped untested): what stops a model that
 * re-issues the same failing tool forever, or grows a trajectory past its token
 * budget, from burning the turn. Pure deterministic tests — the
 * threshold/signature/dedup helpers are exercised directly with synthetic
 * failures and configs; no live model, no DB.
 */
import { describe, expect, it } from "vitest";
import {
	assertRepeatedFailureLimit,
	assertTrajectoryLimit,
	countRepeatedFailures,
	DEFAULT_CHAINING_LOOP_CONFIG,
	type FailureLike,
	getFailureSignature,
	mergeChainingLoopConfig,
	TrajectoryLimitExceeded,
} from "./limits.ts";

describe("mergeChainingLoopConfig", () => {
	it("returns the defaults (with reserve marked non-explicit) when given nothing", () => {
		const merged = mergeChainingLoopConfig();
		expect(merged.maxToolCalls).toBe(DEFAULT_CHAINING_LOOP_CONFIG.maxToolCalls);
		expect(merged.compactionReserveTokensExplicit).toBe(false);
	});

	it("overlays partial overrides on the defaults", () => {
		const merged = mergeChainingLoopConfig({ maxRepeatedFailures: 99 });
		expect(merged.maxRepeatedFailures).toBe(99);
		expect(merged.maxToolCalls).toBe(DEFAULT_CHAINING_LOOP_CONFIG.maxToolCalls);
	});

	it("marks the reserve explicit when the caller sets it", () => {
		expect(
			mergeChainingLoopConfig({ compactionReserveTokens: 4096 })
				.compactionReserveTokensExplicit,
		).toBe(true);
		expect(
			mergeChainingLoopConfig({ compactionReserveTokensExplicit: true })
				.compactionReserveTokensExplicit,
		).toBe(true);
	});
});

describe("assertTrajectoryLimit", () => {
	it("permits observed at or below the max (strict >)", () => {
		expect(() =>
			assertTrajectoryLimit({ kind: "tool_calls", max: 5, observed: 5 }),
		).not.toThrow();
	});

	it("throws a typed TrajectoryLimitExceeded above the max", () => {
		try {
			assertTrajectoryLimit({
				kind: "trajectory_token_budget",
				max: 100,
				observed: 101,
			});
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(TrajectoryLimitExceeded);
			const err = e as TrajectoryLimitExceeded;
			expect(err.kind).toBe("trajectory_token_budget");
			expect(err.max).toBe(100);
			expect(err.observed).toBe(101);
			expect(err.message).toMatch(/trajectory_token_budget \(101\/100\)/);
		}
	});
});

describe("getFailureSignature", () => {
	it("is null for a success (nothing to dedup)", () => {
		expect(getFailureSignature({ success: true })).toBeNull();
		expect(getFailureSignature({})).toBeNull();
	});

	it("derives a signature from an explicit failure with no error", () => {
		expect(getFailureSignature({ success: false, toolName: "WEB_FETCH" })).toBe(
			"WEB_FETCH:failed",
		);
	});

	it("uses the tool name + normalized error message", () => {
		expect(
			getFailureSignature({
				toolName: "  WEB_FETCH ",
				error: new Error("connect   ETIMEDOUT"),
			}),
		).toBe("WEB_FETCH:connect ETIMEDOUT");
		expect(getFailureSignature({ error: "boom" })).toBe("unknown_tool:boom");
		expect(getFailureSignature({ toolName: "X", error: { code: 7 } })).toBe(
			'X:{"code":7}',
		);
	});

	it("caps the error portion at 240 chars", () => {
		const sig = getFailureSignature({ toolName: "X", error: "e".repeat(500) });
		// "X:" + 240 chars
		expect(sig).toHaveLength(2 + 240);
	});
});

describe("countRepeatedFailures / assertRepeatedFailureLimit", () => {
	const fail = (over: Partial<FailureLike> = {}): FailureLike => ({
		toolName: "WEB_FETCH",
		error: "ETIMEDOUT",
		success: false,
		...over,
	});

	it("counts only failures whose signature matches the latest", () => {
		const failures = [fail(), fail(), fail({ error: "OTHER" })];
		expect(countRepeatedFailures(failures, fail())).toBe(2);
	});

	it("returns 0 when the latest is a success (no signature)", () => {
		expect(countRepeatedFailures([fail(), fail()], { success: true })).toBe(0);
	});

	it("treats a different repeatKey as a distinct failure", () => {
		const failures = [
			fail({ repeatKey: "url-a" }),
			fail({ repeatKey: "url-b" }),
		];
		expect(countRepeatedFailures(failures, fail({ repeatKey: "url-a" }))).toBe(
			1,
		);
	});

	it("does not throw at or below the repeated-failure cap", () => {
		expect(() =>
			assertRepeatedFailureLimit({
				failures: [fail(), fail()],
				latestFailure: fail(),
				maxRepeatedFailures: 2,
			}),
		).not.toThrow();
	});

	it("throws repeated_failures once the cap is exceeded", () => {
		try {
			assertRepeatedFailureLimit({
				failures: [fail(), fail(), fail()],
				latestFailure: fail(),
				maxRepeatedFailures: 2,
			});
			throw new Error("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(TrajectoryLimitExceeded);
			expect((e as TrajectoryLimitExceeded).kind).toBe("repeated_failures");
			expect((e as TrajectoryLimitExceeded).observed).toBe(3);
		}
	});
});
