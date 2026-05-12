import { afterEach, describe, expect, it } from "vitest";
import { normalizeActionJsonSchema } from "../../actions/action-schema";
import type { Action } from "../../types";
import {
	buildPlannerActionGrammar,
	buildResponseGrammar,
	clearResponseGrammarCache,
	withGuidedDecodeProviderOptions,
} from "../response-grammar";
import type { ResponseHandlerFieldEvaluator } from "../response-handler-field-evaluator";

function makeAction(name: string, overrides: Partial<Action> = {}): Action {
	return {
		name,
		description: `Run ${name}`,
		handler: async () => undefined,
		validate: async () => true,
		...overrides,
	};
}

const field = (
	overrides: Partial<ResponseHandlerFieldEvaluator>,
): ResponseHandlerFieldEvaluator => ({
	name: "field",
	description: "a field",
	schema: { type: "array", items: { type: "string" } },
	...overrides,
});

describe("buildResponseGrammar — Stage-1 envelope", () => {
	it("emits fixed envelope key order matching HANDLE_RESPONSE_SCHEMA (non-direct)", () => {
		clearResponseGrammarCache();
		const { responseSkeleton, grammar } = buildResponseGrammar(
			{ actions: [] },
			{ contexts: ["tasks", "calendar"] },
		);
		// The skeleton's literal-key glue spans, in order, recover the envelope.
		const keyOrder = responseSkeleton.spans
			.filter((s) => s.key !== undefined && s.kind !== "literal")
			.map((s) => s.key);
		expect(keyOrder).toEqual([
			"shouldRespond",
			"thought",
			"replyText",
			"contexts",
			"contextSlices",
			"candidateActions",
			"parentActionHints",
			"requiresTool",
			"extract",
		]);
		// First span opens the JSON object with the first key.
		expect(responseSkeleton.spans[0]).toEqual({
			kind: "literal",
			value: '{"shouldRespond":',
		});
		// Last span closes it.
		expect(responseSkeleton.spans.at(-1)).toEqual({
			kind: "literal",
			value: "}",
		});
		// shouldRespond is a 3-value enum span.
		const sr = responseSkeleton.spans.find((s) => s.key === "shouldRespond");
		expect(sr?.kind).toBe("enum");
		expect(sr?.enumValues).toEqual(["RESPOND", "IGNORE", "STOP"]);
		// The grammar pins shouldRespond and the contexts element enum.
		expect(grammar).toContain(
			'"\\"RESPOND\\"" | "\\"IGNORE\\"" | "\\"STOP\\""',
		);
		expect(grammar).toContain('"\\"tasks\\""');
		expect(grammar).toContain('"\\"calendar\\""');
		expect(grammar).toContain("contextsarray ::=");
	});

	it("drops shouldRespond on direct channels (DM/API/VOICE_DM/SELF)", () => {
		clearResponseGrammarCache();
		const { responseSkeleton, grammar } = buildResponseGrammar(
			{ actions: [] },
			{ contexts: ["general"], channelType: "DM" },
		);
		expect(responseSkeleton.spans.some((s) => s.key === "shouldRespond")).toBe(
			false,
		);
		expect(responseSkeleton.spans[0]).toEqual({
			kind: "literal",
			value: '{"thought":',
		});
		expect(grammar).not.toContain("shouldrespond ::=");
	});

	it("always merges `simple` and `general` into the contexts element enum", () => {
		clearResponseGrammarCache();
		const { grammar } = buildResponseGrammar(
			{ actions: [] },
			{ contexts: ["onlythis"] },
		);
		expect(grammar).toContain('"\\"onlythis\\""');
		expect(grammar).toContain('"\\"simple\\""');
		expect(grammar).toContain('"\\"general\\""');
	});

	it("collapses a single-value field-evaluator enum to a literal span (zero tokens)", () => {
		clearResponseGrammarCache();
		const { responseSkeleton, grammar } = buildResponseGrammar(
			{
				actions: [],
				responseHandlerFields: [
					field({ name: "mode", schema: { type: "string", enum: ["ONLY"] } }),
				],
			},
			{ contexts: ["general"] },
		);
		const modeSpan = responseSkeleton.spans.find((s) => s.key === "mode");
		expect(modeSpan).toEqual({ kind: "literal", key: "mode", value: '"ONLY"' });
		// The literal is in the grammar root, not as a sampled enum rule.
		expect(grammar).not.toContain("fieldenum_");
		expect(grammar).toContain('"\\"ONLY\\""');
	});

	it("uses the field-registry envelope when registered fields are present", () => {
		clearResponseGrammarCache();
		const { responseSkeleton } = buildResponseGrammar(
			{
				actions: [],
				responseHandlerFields: [
					field({ name: "late", priority: 90, schema: { type: "object" } }),
					field({ name: "early", priority: 20, schema: { type: "object" } }),
				],
			},
			{ contexts: ["general"] },
		);
		const keys = responseSkeleton.spans
			.filter((s) => s.key !== undefined && s.kind !== "literal")
			.map((s) => s.key);
		expect(keys).toEqual(["early", "late"]);
		expect(keys).not.toContain("extract");
		expect(responseSkeleton.spans[0]).toEqual({
			kind: "literal",
			value: '{"early":',
		});
	});

	it("is byte-stable / cached across calls for the same registry snapshot", () => {
		clearResponseGrammarCache();
		const a = buildResponseGrammar({ actions: [] }, { contexts: ["x", "y"] });
		const b = buildResponseGrammar({ actions: [] }, { contexts: ["y", "x"] });
		expect(b).toBe(a); // same object reference from the cache (order-insensitive key)
		expect(b.grammar).toBe(a.grammar);
		// A different context set yields a different result.
		const c = buildResponseGrammar({ actions: [] }, { contexts: ["z"] });
		expect(c).not.toBe(a);
	});
});

describe("normalizeActionJsonSchema", () => {
	it("emits a core JSONSchema object with properties / required / additionalProperties:false", () => {
		const action = makeAction("DO_THING", {
			parameters: [
				{
					name: "target",
					description: "where",
					required: true,
					schema: { type: "string", enum: ["a", "b"] },
				},
				{
					name: "count",
					description: "how many",
					schema: { type: "integer", minimum: 1 },
				},
			],
		});
		const schema = normalizeActionJsonSchema(action);
		expect(schema.type).toBe("object");
		expect(schema.additionalProperties).toBe(false);
		expect(schema.required).toEqual(["target"]);
		expect((schema.properties as Record<string, unknown>).target).toMatchObject(
			{
				type: "string",
				enum: ["a", "b"],
			},
		);
		expect((schema.properties as Record<string, unknown>).count).toMatchObject({
			type: "integer",
			minimum: 1,
		});
	});

	it("honors allowAdditionalParameters", () => {
		const schema = normalizeActionJsonSchema(
			makeAction("OPEN", { allowAdditionalParameters: true, parameters: [] }),
		);
		expect(schema.additionalProperties).toBe(true);
	});

	it("recurses into nested object/array parameter schemas", () => {
		const schema = normalizeActionJsonSchema(
			makeAction("NESTED", {
				parameters: [
					{
						name: "config",
						description: "cfg",
						schema: {
							type: "object",
							properties: { name: { type: "string" } },
							required: ["name"],
						},
					},
					{
						name: "tags",
						description: "tags",
						schema: { type: "array", items: { type: "string" } },
					},
				],
			}),
		);
		const props = schema.properties as Record<
			string,
			{ properties?: unknown; required?: unknown; items?: unknown }
		>;
		expect(props.config.properties).toBeDefined();
		expect(props.config.required).toEqual(["name"]);
		expect(props.tags.items).toMatchObject({ type: "string" });
	});
});

describe("buildPlannerActionGrammar — Stage-2 per-action grammar", () => {
	it("pins `action` to the enum of available action names", () => {
		clearResponseGrammarCache();
		const r = buildPlannerActionGrammar([
			makeAction("ALPHA"),
			makeAction("BRAVO"),
		]);
		if (r === null) throw new Error("expected planner grammar");
		const actionSpan = r.responseSkeleton.spans.find((s) => s.key === "action");
		expect(actionSpan?.kind).toBe("enum");
		expect(actionSpan?.enumValues).toEqual(["ALPHA", "BRAVO"]);
		expect(r.grammar).toContain('actionname ::= "\\"ALPHA\\"" | "\\"BRAVO\\""');
		// Args envelope key order: action, parameters, thought.
		const keys = r.responseSkeleton.spans
			.filter((s) => s.key !== undefined)
			.filter((s) => s.kind !== "literal")
			.map((s) => s.key);
		expect(keys).toEqual(["action", "parameters", "thought"]);
	});

	it("collapses to a literal when exactly one action is exposed", () => {
		clearResponseGrammarCache();
		const r = buildPlannerActionGrammar([makeAction("ONLY")]);
		if (r === null) throw new Error("expected planner grammar");
		const actionSpan = r.responseSkeleton.spans.find((s) => s.key === "action");
		expect(actionSpan).toEqual({
			kind: "literal",
			key: "action",
			value: '"ONLY"',
		});
		expect(r.grammar).not.toContain("actionname ::=");
	});

	it("exposes each action's normalized parameter schema for the second pass", () => {
		clearResponseGrammarCache();
		const r = buildPlannerActionGrammar([
			makeAction("WITH_PARAMS", {
				parameters: [
					{
						name: "url",
						description: "the url",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected planner grammar");
		expect(r.actionSchemas.WITH_PARAMS).toMatchObject({
			type: "object",
			required: ["url"],
		});
	});

	it("returns null when no actions are exposed", () => {
		clearResponseGrammarCache();
		expect(buildPlannerActionGrammar([])).toBeNull();
	});

	it("is cached across calls for the same action set", () => {
		clearResponseGrammarCache();
		const a = buildPlannerActionGrammar([makeAction("A"), makeAction("B")]);
		const b = buildPlannerActionGrammar([makeAction("B"), makeAction("A")]);
		expect(b).toBe(a);
	});
});

describe("withGuidedDecodeProviderOptions", () => {
	const ENV_KEYS = [
		"MILADY_LOCAL_GUIDED_DECODE",
		"ELIZA_LOCAL_GUIDED_DECODE",
	] as const;
	const saved: Record<string, string | undefined> = {};
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	afterEach(() => {
		for (const k of ENV_KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it("sets eliza.guidedDecode = true by default and preserves siblings", () => {
		for (const k of ENV_KEYS) delete process.env[k];
		const opts = withGuidedDecodeProviderOptions({
			eliza: { plannerActionSchemas: { A: { type: "object" } } },
			other: 1,
		} as Record<string, unknown>);
		expect(opts).toMatchObject({
			other: 1,
			eliza: {
				guidedDecode: true,
				plannerActionSchemas: { A: { type: "object" } },
			},
		});
	});

	it("creates the eliza bag when absent", () => {
		for (const k of ENV_KEYS) delete process.env[k];
		const opts = withGuidedDecodeProviderOptions({} as Record<string, unknown>);
		expect((opts as { eliza?: { guidedDecode?: unknown } }).eliza).toEqual({
			guidedDecode: true,
		});
	});

	it("is a no-op when the operator opts out via MILADY_LOCAL_GUIDED_DECODE=0", () => {
		process.env.MILADY_LOCAL_GUIDED_DECODE = "0";
		const opts = withGuidedDecodeProviderOptions({} as Record<string, unknown>);
		expect((opts as { eliza?: unknown }).eliza).toBeUndefined();
	});

	it("is a no-op when ELIZA_LOCAL_GUIDED_DECODE=false", () => {
		process.env.ELIZA_LOCAL_GUIDED_DECODE = "false";
		const opts = withGuidedDecodeProviderOptions({
			eliza: { plannerActionSchemas: {} },
		} as Record<string, unknown>);
		expect(
			(opts as { eliza?: { guidedDecode?: unknown } }).eliza?.guidedDecode,
		).toBeUndefined();
	});

	it("returns the same object reference (idempotent merge)", () => {
		for (const k of ENV_KEYS) delete process.env[k];
		const input = { eliza: { foo: 1 } } as Record<string, unknown>;
		expect(withGuidedDecodeProviderOptions(input)).toBe(input);
		const again = withGuidedDecodeProviderOptions(input);
		expect((again as { eliza?: { guidedDecode?: unknown } }).eliza).toEqual({
			foo: 1,
			guidedDecode: true,
		});
	});
});
