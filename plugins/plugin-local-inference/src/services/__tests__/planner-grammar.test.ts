import { describe, expect, it } from "vitest";
import {
	compileSkeletonToGbnf,
	spanSamplerPlanRequestFields,
} from "../structured-output";

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
