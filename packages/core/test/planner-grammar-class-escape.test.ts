/**
 * The strict planner grammar compiles a `pattern` character class to a GBNF
 * class. llama.cpp's grammar parser reads only `\x \u \U \t \r \n \\ \" \[ \]`
 * after a backslash (parse_char in llama-grammar.cpp) and refuses the whole
 * grammar on any other escape, so a literal `-` or `^` in a class must not be
 * written as `\-` or `\^`.
 */

import { describe, expect, it } from "vitest";
import { buildPlannerActionGrammarStrict } from "../src/runtime/response-grammar";
import type { Action } from "../src/types/components";

const LLAMA_ESCAPE =
	/\\(?:x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|[trn\\"[\]])/y;

function unknownEscapes(grammar: string): string[] {
	const found: string[] = [];
	for (let i = 0; i < grammar.length; i++) {
		if (grammar[i] !== "\\") continue;
		LLAMA_ESCAPE.lastIndex = i;
		const match = LLAMA_ESCAPE.exec(grammar);
		if (match) {
			i += match[0].length - 1;
			continue;
		}
		found.push(grammar.slice(i, i + 2));
		i += 1;
	}
	return found;
}

function plannerGrammar(pattern: string): string {
	const action: Pick<Action, "name" | "parameters"> = {
		name: "PROPOSE_DEVICE_ACTION",
		parameters: [
			{
				name: "operationKey",
				description: "Fresh key for each new operation",
				required: true,
				schema: { type: "string", pattern },
			},
		],
	};
	return buildPlannerActionGrammarStrict([action])?.grammar ?? "";
}

describe("strict planner grammar character classes", () => {
	it("writes a literal hyphen as an escape llama.cpp reads", () => {
		// Same pattern as PROPOSE_DEVICE_ACTION `operationKey`.
		const grammar = plannerGrammar("^[A-Za-z0-9][A-Za-z0-9_-]*$");
		expect(unknownEscapes(grammar)).toEqual([]);
		expect(grammar).toContain("[A-Za-z0-9_\\x2d]*");
	});

	it("writes a literal caret as an escape llama.cpp reads", () => {
		const grammar = plannerGrammar("^[a-z^]+$");
		expect(unknownEscapes(grammar)).toEqual([]);
		expect(grammar).toContain("[a-z\\x5e]+");
	});
});
