/**
 * CALCULATE action: deterministic recursive-descent arithmetic (BigInt-exact
 * integer lane, disclosed float lane), typed rejection of unparseable input,
 * and general-context reachability. Deterministic unit harness; no model.
 */
import { describe, expect, it } from "vitest";
import { inferDirectCurrentRequestCandidateActions } from "../../services/message/direct-action-heuristics.ts";
import type { ActionResult } from "../../types/index.ts";
import { calculateAction, evaluateArithmetic } from "./actions/calculate.ts";
import { basicActions } from "./index.ts";

describe("evaluateArithmetic", () => {
	it("computes the live-incident product exactly", () => {
		// 2026-08-24: the model produced 1,123,186 / 1,122,824 for this ask.
		expect(evaluateArithmetic("3847 * 292")).toEqual({
			text: "1123324",
			exact: true,
		});
	});

	it("honors precedence, parentheses, and unary minus", () => {
		expect(evaluateArithmetic("2 + 3 * 4").text).toBe("14");
		expect(evaluateArithmetic("(2 + 3) * 4").text).toBe("20");
		expect(evaluateArithmetic("-5 + 3").text).toBe("-2");
		expect(evaluateArithmetic("2 ^ 10").text).toBe("1024");
		expect(evaluateArithmetic("2 ** 10").text).toBe("1024");
		expect(evaluateArithmetic("-2 ^ 2").text).toBe("-4");
		expect(evaluateArithmetic("(-2) ^ 2").text).toBe("4");
		expect(evaluateArithmetic("2 ^ -2")).toEqual({
			text: "0.25",
			exact: false,
		});
		expect(evaluateArithmetic("10 % 3").text).toBe("1");
	});

	it("is exact beyond float precision in the integer lane", () => {
		expect(evaluateArithmetic("12345678901234567890 * 2")).toEqual({
			text: "24691357802469135780",
			exact: true,
		});
		const power = evaluateArithmetic("10 ^ 5001");
		expect(power.exact).toBe(true);
		expect(power.text).toHaveLength(5002);
		expect(power.text).toMatch(/^10+$/);
	});

	it("accepts digit separators", () => {
		expect(evaluateArithmetic("1,234 * 1_000").text).toBe("1234000");
	});

	it("division and decimals use the disclosed float lane", () => {
		const r = evaluateArithmetic("847 / 7");
		expect(r).toEqual({ text: "121", exact: false });
		expect(evaluateArithmetic("0.1 + 0.2").text).toBe("0.3");
	});

	it("rejects invalid input and oversized work before returning a partial result", () => {
		for (const bad of [
			"two plus two",
			"x * 3",
			"1,,2 + 3",
			"5 / 0",
			"2 ^ 20000",
			"99 ^ 10000",
			"3 +",
			"1".repeat(10_001),
			`${"(".repeat(300)}1${")".repeat(300)}`,
			`${"-".repeat(300)}1`,
		]) {
			expect(() => evaluateArithmetic(bad)).toThrow();
		}
	});
});

describe("CALCULATE action", () => {
	it("is registered in the basic bundle", () => {
		expect(basicActions.some((a) => a.name === "CALCULATE")).toBe(true);
	});

	it("evaluates through the handler with a complete equation in text", async () => {
		const result = (await calculateAction.handler(
			{} as never,
			{} as never,
			undefined,
			{ parameters: { expression: "3847 * 292" } },
		)) as ActionResult;
		expect(result.success).toBe(true);
		expect(result.text).toBe("3847 * 292 = 1123324");
	});

	it("returns a typed rejection for unparseable input — never a guess", async () => {
		const result = (await calculateAction.handler(
			{} as never,
			{} as never,
			undefined,
			{ parameters: { expression: "the meaning of life" } },
		)) as ActionResult;
		expect(result.success).toBe(false);
		expect((result.data as { error: string }).error).toBe(
			"CALCULATE_INVALID_EXPRESSION",
		);
		expect(result.text).not.toMatch(/= \d/);
	});
});

describe("deterministic arithmetic routing", () => {
	const actions = [{ name: "CALCULATE", similes: [], tags: [] }];

	it("routes explicit multi-digit arithmetic to CALCULATE", () => {
		for (const text of [
			"whats 3847 times 292",
			"3847 * 292?",
			"1,234 divided by 7 pls",
			"what is 12345 plus 999",
			"what is 3847 - 292",
			"3847 / 292",
			"3847 x 292?",
			"calculate 2024-2025",
			"what is 2024-2025?",
		]) {
			expect(inferDirectCurrentRequestCandidateActions(actions, text)).toEqual([
				"CALCULATE",
			]);
		}
	});

	it("leaves two-digit mental math and ordinary prose on the simple path", () => {
		for (const text of [
			"whats 17 times 23",
			"see you at 10 - 11 tomorrow",
			"i walked 5 x this week",
			"no math here at all",
			"our 2024-2025 plan is attached",
			"our 2024 - 2025 plan is attached",
			"ISO 9001-2015 certification",
			"call 555-1234 tomorrow",
			"the 100-200 range",
			"upgrade from version 100/200",
			"use the 1920x1080 image",
			"what is ISO 9001-2015 certification?",
			"what is the 100-200 range?",
			"what is 1920x1080 resolution?",
			"what is version 100/200?",
			"2024-2025",
		]) {
			expect(inferDirectCurrentRequestCandidateActions(actions, text)).toEqual(
				[],
			);
		}
	});
});
