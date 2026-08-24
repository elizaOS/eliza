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
		expect(evaluateArithmetic("10 % 3").text).toBe("1");
	});

	it("is exact beyond float precision in the integer lane", () => {
		expect(evaluateArithmetic("12345678901234567890 * 2")).toEqual({
			text: "24691357802469135780",
			exact: true,
		});
	});

	it("accepts digit separators", () => {
		expect(evaluateArithmetic("1,234 * 1_000").text).toBe("1234000");
	});

	it("division and decimals use the disclosed float lane", () => {
		const r = evaluateArithmetic("847 / 7");
		expect(r).toEqual({ text: "121", exact: false });
		expect(evaluateArithmetic("0.1 + 0.2").text).toBe("0.3");
	});

	it("rejects words, variables, division by zero, and runaway exponents", () => {
		for (const bad of ["two plus two", "x * 3", "5 / 0", "2 ^ 20000", "3 +"]) {
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
		]) {
			expect(inferDirectCurrentRequestCandidateActions(actions, text)).toEqual(
				[],
			);
		}
	});
});
