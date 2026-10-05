/** A bounded integer parameter must be constrained to bare JSON numbers, not
 * JSON-quoted strings, so a grammar-guided model cannot violate its schema. */
import { expect, it } from "vitest";
import type { Action } from "../types/components";
import { buildPlannerActionGrammarStrict } from "./response-grammar";

it("emits bare numeric literals for a bounded integer parameter, not JSON strings", () => {
	const action = {
		name: "SET_COUNT",
		parameters: [
			{
				name: "count",
				required: true,
				schema: { type: "integer", minimum: 0, maximum: 2 },
			},
		],
		allowAdditionalParameters: false,
	} as unknown as Pick<
		Action,
		"name" | "parameters" | "allowAdditionalParameters"
	>;

	const result = buildPlannerActionGrammarStrict([action]);
	expect(result).not.toBeNull();
	const grammar = result?.grammar ?? "";

	// In-range integers must be bare JSON numbers: `"0" | "1" | "2"`.
	expect(grammar).toContain('"0" | "1" | "2"');
	// The bug emitted the JSON-quoted form, i.e. the GBNF token `"\"0\""`,
	// forcing `{"count":"0"}` — a string where the schema declares an integer.
	expect(grammar).not.toMatch(/\\"0\\"/);
});
