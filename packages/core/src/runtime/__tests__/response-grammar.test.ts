import { afterEach, describe, expect, it } from "vitest";
import { normalizeActionJsonSchema } from "../../actions/action-schema";
import type { Action } from "../../types";
import {
	buildPlannerActionGrammar,
	buildPlannerActionGrammarStrict,
	buildPlannerParamsSkeleton,
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

	it("drops shouldRespond on non-voice direct channels (DM/API/SELF)", () => {
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

	it("keeps shouldRespond on voice channels", () => {
		clearResponseGrammarCache();
		const { responseSkeleton, grammar } = buildResponseGrammar(
			{ actions: [] },
			{ contexts: ["general"], channelType: "VOICE_DM" },
		);
		expect(responseSkeleton.spans.some((s) => s.key === "shouldRespond")).toBe(
			true,
		);
		expect(grammar).toContain("shouldrespond ::=");
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

	it("preserves multi-value string field enums as enum spans for prefix shortcuts", () => {
		clearResponseGrammarCache();
		const { responseSkeleton, grammar } = buildResponseGrammar(
			{
				actions: [],
				responseHandlerFields: [
					field({
						name: "shouldRespond",
						priority: 5,
						schema: { type: "string", enum: ["RESPOND", "IGNORE", "STOP"] },
					}),
					field({
						name: "replyText",
						priority: 20,
						schema: { type: "string" },
					}),
				],
			},
			{ contexts: ["general"] },
		);
		const shouldRespondSpan = responseSkeleton.spans.find(
			(span) => span.key === "shouldRespond",
		);
		expect(shouldRespondSpan).toMatchObject({
			kind: "enum",
			enumValues: ["RESPOND", "IGNORE", "STOP"],
		});
		expect(grammar).toContain(
			'"\\"RESPOND\\"" | "\\"IGNORE\\"" | "\\"STOP\\""',
		);
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

describe("buildPlannerParamsSkeleton — second-pass per-action parameters", () => {
	it("returns a `{}` literal span when the action has no parameters", () => {
		const sk = buildPlannerParamsSkeleton(makeAction("NO_PARAMS"));
		expect(sk.spans).toEqual([{ kind: "literal", value: "{}" }]);
	});

	it("emits a free-string span for a string param with no enum", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("FREE", {
				parameters: [
					{
						name: "text",
						description: "free text",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
		);
		const valueSpans = sk.spans.filter((s) => s.kind !== "literal");
		expect(valueSpans).toEqual([{ kind: "free-string", key: "text" }]);
	});

	it("collapses a single-value string enum to a literal", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("ONE", {
				parameters: [
					{
						name: "op",
						description: "only one op",
						required: true,
						schema: { type: "string", enum: ["send"] },
					},
				],
			}),
		);
		const opSpan = sk.spans.find((s) => s.key === "op");
		expect(opSpan).toEqual({ kind: "literal", key: "op", value: '"send"' });
	});

	it("pins a multi-value string enum as an enum span (the gap this closes)", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("MULTI", {
				parameters: [
					{
						name: "kind",
						description: "one of several kinds",
						required: true,
						schema: {
							type: "string",
							enum: ["user", "channel", "thread"],
						},
					},
				],
			}),
		);
		const kindSpan = sk.spans.find((s) => s.key === "kind");
		expect(kindSpan?.kind).toBe("enum");
		expect(kindSpan?.enumValues).toEqual(["user", "channel", "thread"]);
	});

	it("falls back to free-json for non-string parameter types", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("NESTED", {
				parameters: [
					{
						name: "context",
						description: "an object",
						required: true,
						schema: {
							type: "object",
							properties: { kind: { type: "string", enum: ["a", "b"] } },
						},
					},
				],
			}),
		);
		const ctxSpan = sk.spans.find((s) => s.key === "context");
		expect(ctxSpan).toEqual({ kind: "free-json", key: "context" });
	});

	it("differentiates the skeleton id when enum constraints differ", () => {
		// Same param names, different enum sets — id must differ so a downstream
		// grammar cache doesn't return a stale compilation.
		const noEnum = buildPlannerParamsSkeleton(
			makeAction("X", {
				parameters: [
					{
						name: "k",
						description: "",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
		);
		const withEnum = buildPlannerParamsSkeleton(
			makeAction("X", {
				parameters: [
					{
						name: "k",
						description: "",
						required: true,
						schema: { type: "string", enum: ["a", "b"] },
					},
				],
			}),
		);
		expect(noEnum.id).not.toBe(withEnum.id);
	});

	it("rejects non-string enum members (mixed-type enums fall through to free-string)", () => {
		const sk = buildPlannerParamsSkeleton(
			makeAction("MIXED", {
				parameters: [
					{
						name: "n",
						description: "mixed",
						required: true,
						schema: { type: "string", enum: ["a", 1] as unknown as string[] },
					},
				],
			}),
		);
		const nSpan = sk.spans.find((s) => s.key === "n");
		expect(nSpan).toEqual({ kind: "free-string", key: "n" });
	});
});

describe("buildPlannerActionGrammarStrict — single-call per-action union grammar", () => {
	it("returns null when no actions are exposed", () => {
		expect(buildPlannerActionGrammarStrict([])).toBeNull();
	});

	it("emits one call branch per action at the grammar root", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("ALPHA"),
			makeAction("BRAVO"),
		]);
		if (r === null) throw new Error("expected grammar");
		// Branches are root-level alternatives — both call rules referenced
		// from the root.
		expect(r.grammar).toMatch(
			/^root ::= callofaction_ALPHA \| callofaction_BRAVO/m,
		);
		expect(r.grammar).toMatch(/^callofaction_ALPHA ::= /m);
		expect(r.grammar).toMatch(/^callofaction_BRAVO ::= /m);
		// Action name is pinned as a literal inside each call rule, NOT free.
		expect(r.grammar).toContain('"{\\"action\\":\\"ALPHA\\""');
		expect(r.grammar).toContain('"{\\"action\\":\\"BRAVO\\""');
	});

	it("emits an empty `{}` params rule for actions with no parameters", () => {
		const r = buildPlannerActionGrammarStrict([makeAction("EMPTY")]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toMatch(/^paramsofaction_EMPTY ::= "\{\}"$/m);
	});

	it("pins a multi-value string enum as a GBNF alternation in the params rule", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("MSG", {
				parameters: [
					{
						name: "kind",
						description: "the kind",
						required: true,
						schema: {
							type: "string",
							enum: ["user", "channel", "thread"],
						},
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		// The property rule for `kind` should reference the three quoted enum values.
		expect(r.grammar).toContain('"\\"user\\""');
		expect(r.grammar).toContain('"\\"channel\\""');
		expect(r.grammar).toContain('"\\"thread\\""');
		// And NOT fall back to free jsonstring for this property's value.
		expect(r.grammar).toMatch(
			/paramsofaction_MSG_p_kind ::= "\\"kind\\":" \( "\\"user\\"" \| "\\"channel\\"" \| "\\"thread\\"" \)/,
		);
	});

	it("pins an array-of-string-enum element by element", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("CHAR", {
				parameters: [
					{
						name: "fields",
						description: "saveable fields",
						required: true,
						schema: {
							type: "array",
							items: {
								type: "string",
								enum: ["name", "system", "bio"],
							},
						},
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toContain('"\\"name\\""');
		expect(r.grammar).toContain('"\\"system\\""');
		expect(r.grammar).toContain('"\\"bio\\""');
		// Array structure: opening bracket, optional elements, closing bracket.
		expect(r.grammar).toMatch(
			/paramsofaction_CHAR_p_fields ::= "\\"fields\\":" "\[" ws/,
		);
	});

	it("falls back to shared jsonstring for free-text string params", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("REPLY", {
				parameters: [
					{
						name: "text",
						description: "the text",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toMatch(
			/paramsofaction_REPLY_p_text ::= "\\"text\\":" jsonstring/,
		);
		expect(r.grammar).toMatch(/^jsonstring ::= /m);
	});

	it("recurses into object-typed properties with declared sub-properties", () => {
		// Mirrors paymentContext in real actions: object with enum-typed
		// sub-properties. The strict grammar should pin the sub-property
		// enums, not fall back to a loose jsonvalue.
		const r = buildPlannerActionGrammarStrict([
			makeAction("PAYMENT", {
				parameters: [
					{
						name: "paymentContext",
						description: "context",
						required: true,
						schema: {
							type: "object",
							properties: {
								kind: {
									type: "string",
									enum: ["any_payer", "verified_payer", "specific_payer"],
								},
								scope: {
									type: "string",
									enum: ["owner", "owner_or_linked_identity"],
								},
								payerIdentityId: { type: "string" },
							},
							required: ["kind"],
						},
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		// Property rule references the nested object rule, not jsonvalue.
		expect(r.grammar).toMatch(
			/paramsofaction_PAYMENT_p_paymentContext ::= "\\"paymentContext\\":" paramsofaction_PAYMENT_paymentContext_obj/,
		);
		// Nested object rule exists and pins kind's enum members.
		expect(r.grammar).toMatch(/paramsofaction_PAYMENT_paymentContext_obj ::= /);
		expect(r.grammar).toContain('"\\"any_payer\\""');
		expect(r.grammar).toContain('"\\"verified_payer\\""');
		expect(r.grammar).toContain('"\\"specific_payer\\""');
		expect(r.grammar).toContain('"\\"owner\\""');
	});

	it("falls back to jsonvalue for objects without declared sub-properties", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("BAG", {
				parameters: [
					{
						name: "extras",
						description: "freeform bag",
						required: false,
						schema: { type: "object" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toMatch(
			/paramsofaction_BAG_p_extras ::= "\\"extras\\":" jsonvalue/,
		);
	});

	it("recurses into array-of-object items with declared sub-properties", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("PAGES", {
				parameters: [
					{
						name: "entries",
						description: "list of typed records",
						required: true,
						schema: {
							type: "array",
							items: {
								type: "object",
								properties: {
									kind: { type: "string", enum: ["page", "comment"] },
									id: { type: "string" },
								},
								required: ["kind", "id"],
							},
						},
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		// Property rule wraps the item rule in array brackets.
		expect(r.grammar).toMatch(
			/paramsofaction_PAGES_p_entries ::= "\\"entries\\":" "\[" ws \( paramsofaction_PAGES_entries_item /,
		);
		// Item rule exists and references the kind enum.
		expect(r.grammar).toMatch(/paramsofaction_PAGES_entries_item ::= /);
		expect(r.grammar).toContain('"\\"page\\""');
		expect(r.grammar).toContain('"\\"comment\\""');
	});

	it("caps object recursion at MAX_NESTED_OBJECT_DEPTH so cyclic schemas don't explode", () => {
		// Build a 6-deep nested schema. The strict grammar caps recursion at
		// depth 4; depth-5 and below should collapse to jsonvalue.
		const deep = (level: number): JSONSchema => {
			if (level === 0) return { type: "string" };
			return { type: "object", properties: { next: deep(level - 1) } };
		};
		const r = buildPlannerActionGrammarStrict([
			makeAction("DEEP", {
				parameters: [
					{
						name: "root",
						description: "",
						required: true,
						schema: deep(6) as {
							type: "object";
							properties: Record<string, unknown>;
						},
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		// Depths 0..3 each emit their own nested _obj rule; depth 4 stops the
		// recursion and the deepest object falls back to jsonvalue.
		const objRules = (
			r.grammar.match(/paramsofaction_DEEP_(?:[A-Za-z0-9_]+_)*next_obj ::=/g) ??
			[]
		).length;
		expect(objRules).toBeLessThanOrEqual(4);
		expect(r.grammar).toContain("jsonvalue");
	});

	it("emits required-then-optional structure in the params rule", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("MIXED", {
				parameters: [
					{
						name: "a",
						description: "required",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "b",
						description: "optional",
						required: false,
						schema: { type: "string" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		// Required `a` precedes the optional-group; optional `b` is wrapped in
		// `( "," ( ... ) )*` (zero-or-more, leading comma).
		expect(r.grammar).toMatch(
			/paramsofaction_MIXED ::= "\{" paramsofaction_MIXED_p_a \( "," \( paramsofaction_MIXED_p_b \) \)\* "\}"/,
		);
	});

	it("returns a minimal skeleton (the grammar carries the structure)", () => {
		const r = buildPlannerActionGrammarStrict([makeAction("ONE")]);
		if (r === null) throw new Error("expected grammar");
		expect(r.responseSkeleton.spans).toEqual([
			{ kind: "free-json", key: "envelope" },
		]);
		expect(typeof r.responseSkeleton.id).toBe("string");
	});

	it("exposes the same normalized parameter schemas as the loose grammar", () => {
		const r = buildPlannerActionGrammarStrict([
			makeAction("WITH_PARAMS", {
				parameters: [
					{
						name: "url",
						description: "",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
		]);
		if (r === null) throw new Error("expected grammar");
		expect(r.actionSchemas.WITH_PARAMS).toMatchObject({
			type: "object",
			required: ["url"],
			properties: { url: { type: "string" } },
		});
	});

	it("is cached across calls for the same action set", () => {
		const a = buildPlannerActionGrammarStrict([
			makeAction("A"),
			makeAction("B"),
		]);
		const b = buildPlannerActionGrammarStrict([
			makeAction("B"),
			makeAction("A"),
		]);
		expect(b).toBe(a);
	});

	it("does not collide with the loose grammar cache", () => {
		const loose = buildPlannerActionGrammar([makeAction("SAME")]);
		const strict = buildPlannerActionGrammarStrict([makeAction("SAME")]);
		expect(loose).not.toBe(strict);
		if (loose && strict) {
			expect(loose.grammar).not.toBe(strict.grammar);
		}
	});

	it("sanitizes action names that contain GBNF-unsafe characters", () => {
		// Plugin-supplied action names occasionally carry `:` or `.`.
		const r = buildPlannerActionGrammarStrict([makeAction("plugin:foo.bar")]);
		if (r === null) throw new Error("expected grammar");
		expect(r.grammar).toContain("callofaction_plugin_foo_bar");
		expect(r.grammar).not.toContain("callofaction_plugin:foo.bar");
	});
});

describe("buildPlannerActionGrammarStrict — realistic action set (P2-4 production shape)", () => {
	// Mirror the kind of schemas Phase A declared on real actions. The test
	// catches regressions where the grammar generator silently drops a
	// constraint someone added downstream.
	const messageAction = makeAction("MESSAGE", {
		parameters: [
			{
				name: "op",
				description: "messaging operation",
				required: true,
				schema: {
					type: "string",
					enum: ["send", "read_channel", "search", "manage"],
				},
			},
			{
				name: "targetKind",
				description: "kind of target",
				required: false,
				schema: {
					type: "string",
					enum: ["user", "channel", "thread", "group"],
				},
			},
			{
				name: "manageOperation",
				description: "manage op",
				required: false,
				schema: {
					type: "string",
					enum: ["archive", "trash", "spam", "mark_read"],
				},
			},
			{
				name: "text",
				description: "body",
				required: false,
				schema: { type: "string" },
			},
		],
	});
	const paymentAction = makeAction("PAYMENT", {
		parameters: [
			{
				name: "action",
				description: "payment op",
				required: true,
				schema: {
					type: "string",
					enum: ["create_request", "cancel_request"],
				},
			},
			{
				name: "amountCents",
				description: "amount in cents",
				required: false,
				schema: { type: "integer", minimum: 1 },
			},
			{
				name: "paymentContext",
				description: "payer constraint",
				required: false,
				schema: {
					type: "object",
					properties: {
						kind: {
							type: "string",
							enum: ["any_payer", "verified_payer", "specific_payer"],
						},
						scope: {
							type: "string",
							enum: ["owner", "owner_or_linked_identity"],
						},
						payerIdentityId: { type: "string" },
					},
					required: ["kind"],
				},
			},
		],
	});
	const characterAction = makeAction("CHARACTER", {
		parameters: [
			{
				name: "op",
				description: "character op",
				required: true,
				schema: {
					type: "string",
					enum: ["save", "update_identity", "reset"],
				},
			},
			{
				name: "fieldsToSave",
				description: "fields to persist",
				required: false,
				schema: {
					type: "array",
					items: {
						type: "string",
						enum: ["name", "system", "bio", "topics"],
					},
				},
			},
		],
	});
	const ignoreAction = makeAction("IGNORE");

	it("emits one branch per action with action name pinned as a literal", () => {
		const r = buildPlannerActionGrammarStrict([
			messageAction,
			paymentAction,
			characterAction,
			ignoreAction,
		]);
		if (r === null) throw new Error("expected grammar");
		// Root union has one branch per action (alphabetical inside the grammar
		// since the strict builder sorts by name for cache stability).
		expect(r.grammar).toMatch(
			/^root ::= callofaction_CHARACTER \| callofaction_IGNORE \| callofaction_MESSAGE \| callofaction_PAYMENT/m,
		);
		// Each call rule pins the action name as a literal.
		expect(r.grammar).toContain('"{\\"action\\":\\"MESSAGE\\""');
		expect(r.grammar).toContain('"{\\"action\\":\\"PAYMENT\\""');
		expect(r.grammar).toContain('"{\\"action\\":\\"CHARACTER\\""');
		expect(r.grammar).toContain('"{\\"action\\":\\"IGNORE\\""');
	});

	it("pins every declared enum in the realistic action set", () => {
		const r = buildPlannerActionGrammarStrict([
			messageAction,
			paymentAction,
			characterAction,
		]);
		if (r === null) throw new Error("expected grammar");
		// MESSAGE enums
		expect(r.grammar).toContain('"\\"send\\""');
		expect(r.grammar).toContain('"\\"read_channel\\""');
		expect(r.grammar).toContain('"\\"search\\""');
		expect(r.grammar).toContain('"\\"manage\\""');
		expect(r.grammar).toContain('"\\"user\\""');
		expect(r.grammar).toContain('"\\"thread\\""');
		expect(r.grammar).toContain('"\\"archive\\""');
		expect(r.grammar).toContain('"\\"trash\\""');
		// PAYMENT enums (including nested object enums)
		expect(r.grammar).toContain('"\\"create_request\\""');
		expect(r.grammar).toContain('"\\"cancel_request\\""');
		expect(r.grammar).toContain('"\\"any_payer\\""');
		expect(r.grammar).toContain('"\\"verified_payer\\""');
		expect(r.grammar).toContain('"\\"owner_or_linked_identity\\""');
		// CHARACTER enums (including array items)
		expect(r.grammar).toContain('"\\"save\\""');
		expect(r.grammar).toContain('"\\"name\\""');
		expect(r.grammar).toContain('"\\"system\\""');
	});

	it("co-determines action name and parameter shape (no cross-branch leak)", () => {
		// Verify that PAYMENT's params rule references PAYMENT-specific
		// sub-rules, not MESSAGE's or CHARACTER's. This is the property that
		// makes the strict grammar fundamentally different from the loose
		// (independent action/params) variant.
		const r = buildPlannerActionGrammarStrict([
			messageAction,
			paymentAction,
			characterAction,
		]);
		if (r === null) throw new Error("expected grammar");
		// callofaction_PAYMENT references paramsofaction_PAYMENT (not _MESSAGE
		// / _CHARACTER) before the thought field.
		const paymentCallLine = r.grammar
			.split("\n")
			.find((l) => l.startsWith("callofaction_PAYMENT ::="));
		expect(paymentCallLine).toBeDefined();
		expect(paymentCallLine).toContain("paramsofaction_PAYMENT");
		expect(paymentCallLine).not.toContain("paramsofaction_MESSAGE");
		expect(paymentCallLine).not.toContain("paramsofaction_CHARACTER");

		const messageCallLine = r.grammar
			.split("\n")
			.find((l) => l.startsWith("callofaction_MESSAGE ::="));
		expect(messageCallLine).toBeDefined();
		expect(messageCallLine).toContain("paramsofaction_MESSAGE");
		expect(messageCallLine).not.toContain("paramsofaction_PAYMENT");
	});

	it("returns the same actionSchemas map as the loose grammar would", () => {
		const r = buildPlannerActionGrammarStrict([messageAction, paymentAction]);
		const loose = buildPlannerActionGrammar([messageAction, paymentAction]);
		if (r === null || loose === null) throw new Error("expected grammars");
		expect(Object.keys(r.actionSchemas).sort()).toEqual(
			Object.keys(loose.actionSchemas).sort(),
		);
		expect(r.actionSchemas.PAYMENT).toEqual(loose.actionSchemas.PAYMENT);
		expect(r.actionSchemas.MESSAGE).toEqual(loose.actionSchemas.MESSAGE);
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
		// second pass keeps guidedDecode true, no duplication
		const again = withGuidedDecodeProviderOptions(input);
		expect((again as { eliza?: { guidedDecode?: unknown } }).eliza).toEqual({
			foo: 1,
			guidedDecode: true,
		});
	});
});
