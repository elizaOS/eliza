import { afterEach, describe, expect, it } from "vitest";
import type { GenerateTextParams } from "@elizaos/core";
import { resolveBionicMaxTokens } from "./mobile-device-bridge-bootstrap";

// The bionic GPU host does an unconstrained greedy decode (no JSON grammar), so
// a structured call left at the model-metadata default ceiling (8192) runs for
// minutes on the reload-per-call path and trips the post-turn evaluator
// timeout. resolveBionicMaxTokens bounds the decode without truncating the small
// explicit ceilings the should_respond / reply calls already pass.
describe("resolveBionicMaxTokens", () => {
	const envKeys = [
		"ELIZA_BIONIC_STRUCTURED_MAX_TOKENS",
		"ELIZA_BIONIC_MAX_TOKENS",
	];
	afterEach(() => {
		for (const k of envKeys) delete process.env[k];
	});

	const p = (over: Partial<GenerateTextParams>): GenerateTextParams =>
		({ messages: [], ...over }) as GenerateTextParams;

	it("caps the runaway 8192 default to the free ceiling for plain generation", () => {
		expect(resolveBionicMaxTokens(p({ maxTokens: 8192 }))).toBe(2048);
	});

	it("caps a structured (responseSchema) call to the tighter structured ceiling", () => {
		expect(
			resolveBionicMaxTokens(
				p({ maxTokens: 8192, responseSchema: { type: "object" } }),
			),
		).toBe(768);
	});

	it("treats responseFormat json_object (object form) as structured", () => {
		expect(
			resolveBionicMaxTokens(
				p({ maxTokens: 8192, responseFormat: { type: "json_object" } }),
			),
		).toBe(768);
	});

	it("treats responseFormat json_object (string form) as structured", () => {
		expect(
			resolveBionicMaxTokens(p({ maxTokens: 8192, responseFormat: "json_object" })),
		).toBe(768);
	});

	it("passes through small explicit ceilings untouched (should_respond / reply)", () => {
		expect(resolveBionicMaxTokens(p({ maxTokens: 20 }))).toBe(20);
		expect(resolveBionicMaxTokens(p({ maxTokens: 96 }))).toBe(96);
	});

	it("falls back to the free ceiling when no maxTokens is given", () => {
		expect(resolveBionicMaxTokens(p({}))).toBe(2048);
	});

	it("falls back to the structured ceiling for a schema call with no maxTokens", () => {
		expect(
			resolveBionicMaxTokens(p({ responseSchema: { type: "object" } })),
		).toBe(768);
	});

	it("honours operator env overrides for both ceilings", () => {
		process.env.ELIZA_BIONIC_MAX_TOKENS = "1024";
		process.env.ELIZA_BIONIC_STRUCTURED_MAX_TOKENS = "256";
		expect(resolveBionicMaxTokens(p({ maxTokens: 8192 }))).toBe(1024);
		expect(
			resolveBionicMaxTokens(
				p({ maxTokens: 8192, responseSchema: { type: "object" } }),
			),
		).toBe(256);
	});

	it("ignores a non-positive / non-numeric env override and uses the default", () => {
		process.env.ELIZA_BIONIC_MAX_TOKENS = "0";
		expect(resolveBionicMaxTokens(p({ maxTokens: 8192 }))).toBe(2048);
		process.env.ELIZA_BIONIC_MAX_TOKENS = "garbage";
		expect(resolveBionicMaxTokens(p({ maxTokens: 8192 }))).toBe(2048);
	});
});
