import { describe, expect, it } from "vitest";
import { buildPlannerActionGrammarStrict } from "../src/runtime/response-grammar.ts";

describe("buildPlannerActionGrammarStrict rule-name collisions", () => {
	it("keeps properties whose names sanitize to the same GBNF rule apart", () => {
		const result = buildPlannerActionGrammarStrict([
			{
				name: "TEST_ACTION",
				parameters: [
					{
						name: "a_b",
						description: "first",
						required: true,
						schema: { type: "string", enum: ["x"] },
					},
					{
						name: "a-b",
						description: "second",
						required: true,
						schema: { type: "string", enum: ["y"] },
					},
				],
				allowAdditionalParameters: false,
			},
		]);
		expect(result).not.toBeNull();
		const grammar = result?.grammar ?? "";
		// Before the fix both properties shared the `p-a-b` rule, so the
		// grammar forced `"a_b": "x"` twice and could never emit `"a-b"`.
		expect(grammar).toContain('\\"a_b\\":');
		expect(grammar).toContain('\\"a-b\\":');
		expect(grammar).toContain('\\"x\\"');
		expect(grammar).toContain('\\"y\\"');
		expect(grammar).toContain("paramsofaction-TEST-ACTION-p-a-b ::=");
		expect(grammar).toContain("paramsofaction-TEST-ACTION-p-a-b-2 ::=");
	});

	it("keeps actions whose names sanitize to the same GBNF rule apart", () => {
		const result = buildPlannerActionGrammarStrict([
			{
				name: "FOO_BAR",
				parameters: [
					{
						name: "mode",
						description: "mode",
						required: true,
						schema: { type: "string", enum: ["bar"] },
					},
				],
				allowAdditionalParameters: false,
			},
			{
				name: "FOO-BAR",
				parameters: [
					{
						name: "mode",
						description: "mode",
						required: true,
						schema: { type: "string", enum: ["dash"] },
					},
				],
				allowAdditionalParameters: false,
			},
		]);
		expect(result).not.toBeNull();
		const grammar = result?.grammar ?? "";
		const lines = grammar.split("\n");
		const branchLines = lines.filter((line) =>
			line.startsWith("callofaction-"),
		);
		// Before the fix the second action reused the first action's branch
		// and params rules, so its `mode: "dash"` shape was unreachable and
		// its name could pair with the other action's parameters.
		expect(branchLines).toHaveLength(2);
		expect(grammar).toContain("paramsofaction-FOO-BAR ::=");
		expect(grammar).toContain("paramsofaction-FOO-BAR-2 ::=");
		// Both parameter shapes survive under distinct rules (which action
		// takes the `-2` suffix follows the descriptor sort order, so do not
		// pin it here).
		const modeRules = lines.filter((line) =>
			/paramsofaction-FOO-BAR(?:-\d+)?-p-mode ::=/.test(line),
		);
		expect(modeRules).toHaveLength(2);
		expect(
			new Set(
				modeRules.map((line) => (line.includes('\\"bar\\"') ? "bar" : "dash")),
			),
		).toEqual(new Set(["bar", "dash"]));
		// Each branch binds to the params rule carrying its own mode value.
		for (const branch of branchLines) {
			const paramsRule = branch.match(/paramsofaction-FOO-BAR(?:-\d+)?/)?.[0];
			expect(paramsRule).toBeDefined();
			const modeLine = lines.find((line) =>
				line.startsWith(`${paramsRule}-p-mode ::= `),
			);
			expect(modeLine).toBeDefined();
			if (branch.includes('\\"FOO_BAR\\"')) {
				expect(modeLine).toContain('\\"bar\\"');
			} else {
				expect(modeLine).toContain('\\"dash\\"');
			}
		}
	});
});
