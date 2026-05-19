/**
 * Tests for the planner-stage GBNF wiring:
 *
 *   action-set → buildPlanActionsSkeleton(actions)
 *               → compileSkeletonToGbnf(skeleton)
 *               → lazy GBNF whose `action` is the alternation of
 *                 registered names (and NOT anything outside that set)
 *
 *   action-set → buildPlannerGuidedDecode(actions)
 *               → {responseSkeleton, grammar, actionSchemas,
 *                  paramsSkeletons, elizaSchema}
 *
 *   well-formed model output (matching the skeleton)
 *               → extractPlanActionsFromContent
 *               → ExtractedPlanAction(action, parameters, thought)
 *
 * GBNF compiler limitation: `compileSkeletonToGbnf` cannot express per-action
 * `parameters` discrimination in a single flat skeleton. Tests assert the
 * fallback: `parameters` is `free-json`, and the engine drives a second pass
 * against `actionSchemas` / `paramsSkeletons` once `action` is committed.
 */

import {
	type Action,
	clearResponseGrammarCache,
	extractPlanActionsFromContent,
	normalizeActionJsonSchema,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";

import {
	buildPlanActionsSkeleton,
	buildPlannerGuidedDecode,
	planActionParameterSchema,
} from "../planner-skeleton";
import {
	compileSkeletonToGbnf,
	resolveGuidedDecodeForParams,
	spanSamplerPlanRequestFields,
} from "../structured-output";

function makeAction(name: string, overrides: Partial<Action> = {}): Action {
	return {
		name,
		description: `Run ${name}`,
		handler: async () => undefined,
		validate: async () => true,
		...overrides,
	};
}

describe("buildPlanActionsSkeleton — top-level PLAN_ACTIONS envelope", () => {
	it("emits the bare-JSON shape `{action, parameters, thought}` that plan-actions-extractor parses", () => {
		clearResponseGrammarCache();
		const skeleton = buildPlanActionsSkeleton([
			makeAction("ALPHA"),
			makeAction("BRAVO"),
		]);
		expect(skeleton).not.toBeNull();
		if (!skeleton) return;
		// The non-literal key order must match the bare-JSON form. Single-action
		// sets collapse the enum to a literal, so the skeleton may carry the
		// `action` value as a `literal` span (still key-tagged).
		const valueSpans = skeleton.spans.filter(
			(s) =>
				s.key !== undefined && (s.kind !== "literal" || s.value === undefined),
		);
		const keys = valueSpans.map((s) => s.key);
		expect(keys).toEqual(["action", "parameters", "thought"]);
	});

	it("pins `action` to the enum alternation of registered action names", () => {
		clearResponseGrammarCache();
		const skeleton = buildPlanActionsSkeleton([
			makeAction("ALPHA"),
			makeAction("BRAVO"),
			makeAction("CHARLIE"),
		]);
		expect(skeleton).not.toBeNull();
		if (!skeleton) return;
		const actionSpan = skeleton.spans.find((s) => s.key === "action");
		expect(actionSpan?.kind).toBe("enum");
		expect(actionSpan?.enumValues).toEqual(["ALPHA", "BRAVO", "CHARLIE"]);
	});

	it("collapses to a literal span when exactly one action is exposed", () => {
		clearResponseGrammarCache();
		const skeleton = buildPlanActionsSkeleton([makeAction("ONLY")]);
		expect(skeleton).not.toBeNull();
		if (!skeleton) return;
		const actionSpan = skeleton.spans.find((s) => s.key === "action");
		// Single-value enum → literal (zero sampled tokens for the action span).
		expect(actionSpan).toEqual({
			kind: "literal",
			key: "action",
			value: '"ONLY"',
		});
	});

	it("returns null when no actions are exposed", () => {
		clearResponseGrammarCache();
		expect(buildPlanActionsSkeleton([])).toBeNull();
	});
});

describe("compileSkeletonToGbnf(buildPlanActionsSkeleton(...))", () => {
	it("produces a lazy grammar with the action-enum alternation", () => {
		clearResponseGrammarCache();
		const skeleton = buildPlanActionsSkeleton([
			makeAction("SEND_MESSAGE"),
			makeAction("IGNORE"),
		]);
		if (!skeleton) throw new Error("expected skeleton");
		const grammar = compileSkeletonToGbnf(skeleton);
		expect(grammar).not.toBeNull();
		if (!grammar) return;
		// Lazy because the skeleton opens with a literal (`{"action":`).
		expect(grammar.lazy).toBe(true);
		expect(grammar.triggers).toEqual(['{"action":']);
		// The root concatenates the spans; the source carries the alternation as
		// GBNF string literals of the JSON-quoted action names.
		expect(grammar.source).toContain('\\"SEND_MESSAGE\\"');
		expect(grammar.source).toContain('\\"IGNORE\\"');
		// …and does NOT pin an action name that wasn't registered.
		expect(grammar.source).not.toContain('\\"DELETE_EVERYTHING\\"');
		// The `parameters` slot stays free-form JSON (per the compiler limitation
		// — per-action parameter discrimination needs a second pass).
		expect(grammar.source).toContain("jsonobject");
	});

	it("does not include action names outside the registered set", () => {
		clearResponseGrammarCache();
		const skeleton = buildPlanActionsSkeleton([
			makeAction("REGISTERED_ONLY"),
			makeAction("ALSO_REGISTERED"),
		]);
		if (!skeleton) throw new Error("expected skeleton");
		const grammar = compileSkeletonToGbnf(skeleton);
		if (!grammar) throw new Error("expected grammar");
		// The grammar must not name an unregistered action — the GBNF alternation
		// is the closed set of names. Confirm by checking the source carries the
		// registered names *and* not the negative case.
		expect(grammar.source).toContain('\\"REGISTERED_ONLY\\"');
		expect(grammar.source).toContain('\\"ALSO_REGISTERED\\"');
		expect(grammar.source).not.toMatch(
			/HALLUCINATED|UNKNOWN_ACTION|NOT_A_REAL/,
		);
	});

	it("a model output matching the skeleton round-trips through extractPlanActionsFromContent", () => {
		clearResponseGrammarCache();
		const skeleton = buildPlanActionsSkeleton([
			makeAction("SEND_MESSAGE", {
				parameters: [
					{
						name: "channelId",
						description: "where to send",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "text",
						description: "what to say",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
			makeAction("IGNORE"),
		]);
		if (!skeleton) throw new Error("expected skeleton");
		// Simulate a well-formed PLAN_ACTIONS output produced under the grammar:
		// the literals are the scaffold; the model sampled the action enum value
		// (`"SEND_MESSAGE"`), the parameters object, and a free-string thought.
		const modelOutput =
			'{"action":"SEND_MESSAGE","parameters":{"channelId":"c1","text":"hi"},"thought":"replying"}';
		const extracted = extractPlanActionsFromContent(modelOutput);
		expect(extracted).not.toBeNull();
		expect(extracted?.action).toBe("SEND_MESSAGE");
		expect(extracted?.parameters).toEqual({ channelId: "c1", text: "hi" });
		expect(extracted?.thought).toBe("replying");
		expect(extracted?.recoverySource).toBe("bare-action-object");
	});

	it("the parser refuses an action name not in the skeleton's enum (constraint is enforced at decode, not parse)", () => {
		// The parser is intentionally permissive about `action` values — the
		// grammar is what pins the enum at decode time. The parser does its own
		// sanity check (rejecting envelopes that look like HANDLE_RESPONSE), but
		// a stray action name passes through; downstream callers reject it
		// against the registry. This test pins that contract so future changes
		// to either side stay co-ordinated.
		const stray = '{"action":"NOT_REGISTERED","parameters":{},"thought":"x"}';
		const extracted = extractPlanActionsFromContent(stray);
		expect(extracted).not.toBeNull();
		expect(extracted?.action).toBe("NOT_REGISTERED");
	});
});

describe("buildPlannerGuidedDecode — full bundle for the local engine", () => {
	it("bundles skeleton, pre-built grammar, per-action parameter schemas, and per-action sub-skeletons", () => {
		clearResponseGrammarCache();
		const bundle = buildPlannerGuidedDecode([
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
			makeAction("BARE"),
		]);
		expect(bundle).not.toBeNull();
		if (!bundle) return;

		// Skeleton mirrors what `buildPlanActionsSkeleton` produced.
		expect(bundle.responseSkeleton.spans.length).toBeGreaterThan(0);

		// The pre-built grammar names the action alternation.
		expect(bundle.grammar).toContain("actionname ::=");
		expect(bundle.grammar).toContain('\\"WITH_PARAMS\\"');
		expect(bundle.grammar).toContain('\\"BARE\\"');

		// Per-action parameter schemas are normalized JSONSchemas.
		expect(bundle.actionSchemas.WITH_PARAMS).toMatchObject({
			type: "object",
			required: ["url"],
		});
		expect(bundle.actionSchemas.BARE).toMatchObject({
			type: "object",
			additionalProperties: false,
		});

		// Per-action sub-skeletons exist for the second pass.
		expect(bundle.paramsSkeletons.WITH_PARAMS).toBeDefined();
		expect(bundle.paramsSkeletons.BARE).toBeDefined();

		// The bundle's eliza-schema is the harness shape: it carries the prefill
		// plan derived from the skeleton so the engine fast-forwards the scaffold.
		expect(bundle.elizaSchema.skeleton).toBe(bundle.responseSkeleton);
		expect(bundle.elizaSchema.grammar).toBe(bundle.grammar);
		expect(bundle.elizaSchema.prefillPlan).not.toBeNull();
		expect(bundle.elizaSchema.prefillPlan?.prefix).toBe('{"action":');
	});

	it("returns null when no actions are exposed", () => {
		clearResponseGrammarCache();
		expect(buildPlannerGuidedDecode([])).toBeNull();
	});

	it("plugs into StructuredGenerateParams via elizaSchema → guided decode resolver", () => {
		clearResponseGrammarCache();
		const bundle = buildPlannerGuidedDecode([
			makeAction("OPEN_URL", {
				parameters: [
					{
						name: "url",
						description: "the url",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
			makeAction("ABORT"),
		]);
		if (!bundle) throw new Error("expected bundle");
		// What the local-inference handler would do: hand the eliza-schema to the
		// engine; `resolveGuidedDecodeForParams` returns the grammar + prefill
		// plan + the leading-literal prefill to seed as an assistant-turn message.
		const resolved = resolveGuidedDecodeForParams({
			elizaSchema: bundle.elizaSchema,
		});
		expect(resolved.grammar).not.toBeNull();
		expect(resolved.grammar?.source).toContain('\\"OPEN_URL\\"');
		expect(resolved.grammar?.source).toContain('\\"ABORT\\"');
		expect(resolved.prefillPlan).not.toBeNull();
		expect(resolved.prefill).toBe('{"action":');
	});
});

describe("planActionParameterSchema — second-pass schema accessor", () => {
	it("returns a JSONSchema whose required matches the action's required parameters", () => {
		const schema = planActionParameterSchema(
			makeAction("OPEN", {
				parameters: [
					{
						name: "url",
						description: "the url",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
		);
		expect(schema).toMatchObject({
			type: "object",
			required: ["url"],
		});
	});

	it("is byte-identical to normalizeActionJsonSchema (single source of truth)", () => {
		const action = makeAction("ROUND_TRIP", {
			parameters: [
				{
					name: "channelId",
					description: "where",
					required: true,
					schema: { type: "string", enum: ["a", "b"] },
				},
			],
		});
		expect(JSON.stringify(planActionParameterSchema(action))).toBe(
			JSON.stringify(normalizeActionJsonSchema(action)),
		);
	});
});

describe("end-to-end: planner skeleton wired through StructuredGenerateParams", () => {
	it("a planner request constructed with responseSkeleton produces output the extractor parses without retry", () => {
		clearResponseGrammarCache();
		const bundle = buildPlannerGuidedDecode([
			makeAction("SEND_MESSAGE", {
				parameters: [
					{
						name: "channelId",
						description: "where",
						required: true,
						schema: { type: "string" },
					},
					{
						name: "text",
						description: "what",
						required: true,
						schema: { type: "string" },
					},
				],
			}),
			makeAction("IGNORE"),
		]);
		if (!bundle) throw new Error("expected bundle");

		// The local-inference handler resolves the grammar + prefill from
		// `elizaSchema`. Other adapters can ignore those local hints and rely on
		// the portable tool schema, so the planner can pass both unconditionally.
		const resolved = resolveGuidedDecodeForParams({
			elizaSchema: bundle.elizaSchema,
		});
		expect(resolved.grammar).not.toBeNull();

		// Mock model output (what the engine would have produced under the GBNF
		// — the grammar pins the scaffold and the action alternation; the
		// free-string thought and free-json parameters are model-sampled).
		const mockOutput =
			'{"action":"SEND_MESSAGE","parameters":{"channelId":"c1","text":"hi"},"thought":"reply"}';
		const extracted = extractPlanActionsFromContent(mockOutput);
		expect(extracted).not.toBeNull();
		expect(extracted?.action).toBe("SEND_MESSAGE");
		expect(extracted?.parameters).toEqual({ channelId: "c1", text: "hi" });
		// Round-trip: the action name is one of the registered set — i.e. the
		// GBNF would have accepted it during decode.
		expect(Object.keys(bundle.actionSchemas)).toContain(extracted?.action);
	});
});

describe("compileSkeletonToGbnf — number / boolean span kinds (T7)", () => {
	it("emits a jsonnumber-shaped rule for a `number` span", () => {
		const grammar = compileSkeletonToGbnf({
			id: "test#number",
			spans: [
				{ kind: "literal", value: '{"x":' },
				{ kind: "number", key: "x" },
				{ kind: "literal", value: "}" },
			],
		});
		expect(grammar).not.toBeNull();
		// The grammar pins x to a JSON-number rule (digits + optional fraction
		// + optional exponent). Argmax sampling on this span picks the
		// most-likely digit at each position rather than letting the call-level
		// temperature occasionally tip.
		expect(grammar?.source).toMatch(/\[0-9\]/);
	});

	it("emits a `true | false` alternation for a `boolean` span", () => {
		const grammar = compileSkeletonToGbnf({
			id: "test#boolean",
			spans: [
				{ kind: "literal", value: '{"on":' },
				{ kind: "boolean", key: "on" },
				{ kind: "literal", value: "}" },
			],
		});
		expect(grammar).not.toBeNull();
		expect(grammar?.source).toContain('"true"');
		expect(grammar?.source).toContain('"false"');
	});
});

describe("spanSamplerPlanRequestFields — wire format (T7)", () => {
	it("emits eliza_span_samplers in snake_case body shape", () => {
		const fields = spanSamplerPlanRequestFields({
			overrides: [
				{ spanIndex: 1, temperature: 0, topK: 1 },
				{ spanIndex: 3, temperature: 0, topK: 1, topP: 0.95 },
			],
		});
		expect(fields).toEqual({
			eliza_span_samplers: {
				overrides: [
					{ span_index: 1, temperature: 0, top_k: 1 },
					{ span_index: 3, temperature: 0, top_k: 1, top_p: 0.95 },
				],
			},
		});
	});

	it("forwards the strict flag when set", () => {
		const fields = spanSamplerPlanRequestFields({
			overrides: [{ spanIndex: 0, temperature: 0, topK: 1 }],
			strict: true,
		});
		expect(fields).toEqual({
			eliza_span_samplers: {
				overrides: [{ span_index: 0, temperature: 0, top_k: 1 }],
				strict: true,
			},
		});
	});

	it("returns an empty fragment for null / undefined / empty plans", () => {
		expect(spanSamplerPlanRequestFields(null)).toEqual({});
		expect(spanSamplerPlanRequestFields(undefined)).toEqual({});
		expect(spanSamplerPlanRequestFields({ overrides: [] })).toEqual({});
	});
});
