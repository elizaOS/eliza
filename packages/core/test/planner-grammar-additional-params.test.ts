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
		expect(grammar.get(`${P}--additional`)).toBe('jsonstring ":" jsonvalue');
		expect(grammar.has("jsonvalue")).toBe(true);
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
			'jsonstring ":" jsonvalue',
		);
		expect(grammar.get(`${W}-labels-obj--additional`)).toBe(
			'jsonstring ":" jsonbool',
		);
	});
});
