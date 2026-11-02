/**
 * The strict planner grammar compiles a simple string `pattern` to GBNF. The
 * compiled body must sit between JSON quotes, or the local model can only
 * write `{"date":2026-05-10}`, which no JSON parser accepts.
 */

import { describe, expect, it } from "vitest";
import { buildPlannerActionGrammarStrict } from "../src/runtime/response-grammar";
import type { Action } from "../src/types/components";

function valueRule(pattern: string): string | undefined {
	const action: Pick<Action, "name" | "parameters"> = {
		name: "OWNER_HEALTH",
		parameters: [
			{
				name: "date",
				description: "YYYY-MM-DD local day",
				schema: { type: "string", pattern },
			},
		],
	};
	return buildPlannerActionGrammarStrict([action])
		?.grammar.split("\n")
		.find((line) => line.startsWith("paramsofaction-OWNER-HEALTH-p-date ::= "));
}

describe("strict planner grammar for pattern strings", () => {
	it("puts a compiled pattern between JSON quotes", () => {
		// Same parameter as plugin-health OWNER_HEALTH `date`.
		expect(valueRule("^\\d{4}-\\d{2}-\\d{2}$")).toBe(
			'paramsofaction-OWNER-HEALTH-p-date ::= "\\"date\\":" "\\"" [0-9] [0-9] [0-9] [0-9] "-" [0-9] [0-9] "-" [0-9] [0-9] "\\""',
		);
	});

	it("quotes a class that cannot match a character JSON escapes", () => {
		expect(valueRule("^[a-z]+$")).toBe(
			'paramsofaction-OWNER-HEALTH-p-date ::= "\\"date\\":" "\\"" [a-z]+ "\\""',
		);
	});

	it("keeps jsonstring when the pattern can match a character JSON escapes", () => {
		for (const pattern of [
			'^a"b$',
			"^a\\\\b$",
			"^\\s+$",
			"^[\\t ]+$",
			// Ranges that span a quote or a backslash without naming either.
			"^[ -~]+$",
			"^[!-#]+$",
			"^[Z-^]+$",
		]) {
			expect(valueRule(pattern)).toBe(
				'paramsofaction-OWNER-HEALTH-p-date ::= "\\"date\\":" jsonstring',
			);
		}
	});
});
