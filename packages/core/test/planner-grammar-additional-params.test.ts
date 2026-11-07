/**
 * The strict planner grammar must admit the keys an action's parameter schema
 * admits. `allowAdditionalParameters: true` (and `additionalProperties` on a
 * nested object) lets `validateToolArgs` accept undeclared keys, so the local
 * grammar has to let the model write them too.
 */

import { describe, expect, it } from "vitest";
import { buildPlannerActionGrammarStrict } from "../src/runtime/response-grammar";
import type { Action } from "../src/types/components";

type PlannerAction = Pick<
	Action,
	"name" | "parameters" | "allowAdditionalParameters"
>;

function rules(action: PlannerAction): Map<string, string> {
	const grammar = buildPlannerActionGrammarStrict([action])?.grammar ?? "";
	const out = new Map<string, string>();
	for (const line of grammar.split("\n")) {
		const at = line.indexOf(" ::= ");
		out.set(line.slice(0, at), line.slice(at + 5));
	}
	return out;
}

/**
 * RegExp source for a regular GBNF expression (literals, classes, groups, `|`,
 * `*`, rule names), so a test can check which strings a rule admits rather
 * than how its text reads.
 */
function gbnfRegExpSource(grammar: Map<string, string>, expr: string): string {
	let out = "";
	for (const [, literal, charClass, operator, name] of expr.matchAll(
		/"((?:\\.|[^"\\])*)"|(\[(?:\\.|[^\]\\])*\])|([()|*?+])|([A-Za-z][\w-]*)/g,
	)) {
		if (literal !== undefined) {
			const text = JSON.parse(`"${literal}"`) as string;
			out += text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		} else if (charClass !== undefined) out += charClass;
		else if (operator !== undefined) out += operator;
		else out += `(?:${gbnfRegExpSource(grammar, grammar.get(name) ?? "")})`;
	}
	return out;
}

/** The keys an undeclared `"key":value` rule admits, as a whole-string RegExp. */
function undeclaredKeys(grammar: Map<string, string>, rule: string): RegExp {
	const pair = grammar.get(rule) ?? "";
	const key = pair.slice(0, pair.indexOf(' ":" '));
	return new RegExp(`^${gbnfRegExpSource(grammar, key)}$`);
}

// Same declared parameters as PAGE_DELEGATE (packages/agent page-action-groups.ts).
const pageDelegate = (allowAdditionalParameters?: boolean): PlannerAction => ({
	name: "PAGE_DELEGATE",
	allowAdditionalParameters,
	parameters: [
		{
			name: "page",
			description: "Page context",
			required: true,
			schema: { type: "string", enum: ["browser", "wallet"] },
		},
		{
			name: "action",
			description: "Child action name",
			required: true,
			schema: { type: "string" },
		},
	],
});

const P = "paramsofaction-PAGE-DELEGATE";

describe("strict planner grammar for additional parameters", () => {
	it("lets an action that allows additional parameters write undeclared keys", () => {
		const grammar = rules(pageDelegate(true));
		expect(grammar.get(P)).toBe(
			`"{" ${P}-p-page "," ${P}-p-action ( "," ( ${P}--additional ) )* "}"`,
		);
		expect(grammar.get(`${P}--additional`)).toBe(
			`${P}--additional-key ":" jsonvalue`,
		);
		expect(grammar.has("jsonvalue")).toBe(true);
	});

	it("does not let an undeclared pair repeat a declared key", () => {
		// JSON.parse keeps the last copy of a repeated key, so a second "page"
		// written as an undeclared pair would replace the enum-checked value.
		const keys = undeclaredKeys(rules(pageDelegate(true)), `${P}--additional`);
		for (const declared of ['"page"', '"action"', '"p\\u0061ge"']) {
			expect(keys.test(declared), declared).toBe(false);
		}
		for (const undeclared of [
			'"subaction"',
			'"url"',
			'"pag"',
			'"pages"',
			'"x\\u0061"',
		]) {
			expect(keys.test(undeclared), undeclared).toBe(true);
		}
	});

	it("keeps only the declared keys when additional parameters are not allowed", () => {
		const grammar = rules(pageDelegate());
		expect(grammar.get(P)).toBe(`"{" ${P}-p-page "," ${P}-p-action "}"`);
		expect(grammar.has(`${P}--additional`)).toBe(false);
	});

	it("admits any object for an action with no declared parameters", () => {
		const grammar = rules({
			name: "FORWARD",
			allowAdditionalParameters: true,
			parameters: [],
		});
		const F = "paramsofaction-FORWARD";
		expect(grammar.get(F)).toBe(
			`"{" ( ( ${F}--additional ) ( "," ( ${F}--additional ) )* )? "}"`,
		);
	});

	it("follows additionalProperties on a nested object", () => {
		const grammar = rules({
			name: "WORK_THREAD",
			parameters: [
				{
					name: "sourceRef",
					description: "Source reference",
					required: true,
					schema: {
						type: "object",
						properties: { roomId: { type: "string" } },
						required: ["roomId"],
						additionalProperties: true,
					},
				},
				{
					name: "labels",
					description: "Labels by key",
					schema: {
						type: "object",
						properties: { kind: { type: "string" } },
						additionalProperties: { type: "boolean" },
					},
				},
			],
		});
		const W = "paramsofaction-WORK-THREAD";
		expect(grammar.get(`${W}-sourceRef-obj`)).toBe(
			`"{" ${W}-sourceRef-obj-p-roomId ( "," ( ${W}-sourceRef-obj--additional ) )* "}"`,
		);
		expect(grammar.get(`${W}-sourceRef-obj--additional`)).toBe(
			`${W}-sourceRef-obj--additional-key ":" jsonvalue`,
		);
		expect(grammar.get(`${W}-labels-obj--additional`)).toBe(
			`${W}-labels-obj--additional-key ":" jsonbool`,
		);
		const labelKeys = undeclaredKeys(grammar, `${W}-labels-obj--additional`);
		expect(labelKeys.test('"kind"')).toBe(false);
		expect(labelKeys.test('"urgent"')).toBe(true);
	});
});
