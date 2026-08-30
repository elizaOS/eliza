/**
 * Deterministic unit tests for the production PII_SCRUB handler lane — the
 * prompt builder and fail-closed completion parser, plus the registered
 * handler exercised through the plugin's model map with a scripted backend
 * service standing in for the resident llama.cpp runtime (no model download).
 */

import { ModelType, type PiiScrubParams } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { createLocalInferenceModelHandlers } from "../provider.js";
import { buildPiiScrubPrompt, parseScrubCompletion } from "./scrub-handler.js";

const PARAMS: PiiScrubParams = {
	text: "Meeting notes: Alice Johnson met Acme Corp about the Q3 audit.",
	candidateSpans: ["Alice Johnson", "Acme Corp"],
	contextPack: "Resolved entity candidates:\n- entity:e1 (person)",
	pseudonymAssignments: [
		{ entityClusterId: "entity:e1", surrogate: "Nora Vane", kind: "person" },
	],
	rulesetVersion: "2026.08",
};

describe("buildPiiScrubPrompt", () => {
	it("carries the text, candidates, context pack, and assignment surrogates", () => {
		const prompt = buildPiiScrubPrompt(PARAMS);
		expect(prompt).toContain("Alice Johnson");
		expect(prompt).toContain('"Acme Corp"');
		expect(prompt).toContain("Resolved entity candidates");
		expect(prompt).toContain("entity:e1");
		expect(prompt).toContain('"Nora Vane"');
		expect(prompt).toContain(PARAMS.text);
	});

	it("omits the context and assignment sections when absent", () => {
		const prompt = buildPiiScrubPrompt({
			...PARAMS,
			contextPack: undefined,
			pseudonymAssignments: undefined,
		});
		expect(prompt).not.toContain("Context:");
		expect(prompt).not.toContain("Pseudonym assignments");
	});
});

describe("parseScrubCompletion (fail-closed)", () => {
	it("parses one verdict per candidate and keeps safe verdicts replacement-free", () => {
		const verdicts = parseScrubCompletion(
			`[{"span":"Alice Johnson","verdict":"pii","replacement":"Nora Vane","cluster":"entity:e1"},
			  {"span":"Acme Corp","verdict":"safe"}]`,
			PARAMS,
		);
		expect(verdicts).toHaveLength(2);
		const pii = verdicts.find((v) => v.span === "Alice Johnson");
		expect(pii?.kind).toBe("pii");
		expect(pii?.replacement).toBe("Nora Vane");
		expect(pii?.entityClusterId).toBe("entity:e1");
		const safe = verdicts.find((v) => v.span === "Acme Corp");
		expect(safe?.kind).toBe("safe");
		expect(safe?.replacement).toBeUndefined();
	});

	it("forces the assignment surrogate over a divergent model replacement (consistency is structural)", () => {
		const verdicts = parseScrubCompletion(
			`[{"span":"Alice Johnson","verdict":"pii","replacement":"SOMEONE ELSE","cluster":"entity:e1"},
			  {"span":"Acme Corp","verdict":"safe"}]`,
			PARAMS,
		);
		const pii = verdicts.find((v) => v.span === "Alice Johnson");
		expect(pii?.replacement).toBe("Nora Vane");
	});

	it("drops hallucinated spans not present in the source text but still requires candidate coverage", () => {
		const verdicts = parseScrubCompletion(
			`[{"span":"Alice Johnson","verdict":"pii","replacement":"Nora Vane"},
			  {"span":"Ghost Name","verdict":"pii","replacement":"Whoever"},
			  {"span":"Acme Corp","verdict":"safe"}]`,
			PARAMS,
		);
		expect(verdicts.map((v) => v.span).sort()).toEqual([
			"Acme Corp",
			"Alice Johnson",
		]);
	});

	it("throws when a candidate span receives no verdict (never silently clean)", () => {
		expect(() =>
			parseScrubCompletion(
				'[{"span":"Alice Johnson","verdict":"pii","replacement":"Nora Vane"}]',
				PARAMS,
			),
		).toThrow(/omitted a verdict/);
	});

	it("throws on a pii verdict lacking a usable replacement", () => {
		expect(() =>
			parseScrubCompletion(
				`[{"span":"Alice Johnson","verdict":"pii"},
				  {"span":"Acme Corp","verdict":"safe"}]`,
				PARAMS,
			),
		).toThrow(/lacks a usable replacement/);
	});

	it("throws on a replacement equal to the original value (non-redaction)", () => {
		expect(() =>
			parseScrubCompletion(
				`[{"span":"Alice Johnson","verdict":"pii","replacement":"Alice Johnson"},
				  {"span":"Acme Corp","verdict":"safe"}]`,
				{ ...PARAMS, pseudonymAssignments: [] },
			),
		).toThrow(/lacks a usable replacement/);
	});

	it("throws on unknown verdict kinds and non-JSON output", () => {
		expect(() =>
			parseScrubCompletion(
				'[{"span":"Alice Johnson","verdict":"maybe"}]',
				PARAMS,
			),
		).toThrow(/unknown kind/);
		expect(() => parseScrubCompletion("no json here", PARAMS)).toThrow(
			/no JSON array/,
		);
	});
});

describe("registered PII_SCRUB model handler (production model map)", () => {
	function runtimeWithBackend(completion: string) {
		const prompts: string[] = [];
		const requests: Array<{ prompt: string; maxTokens?: number }> = [];
		return {
			prompts,
			requests,
			runtime: {
				agentId: "00000000-0000-0000-0000-000000000001",
				getService: (name: string) =>
					name === "localInference"
						? {
								generate: async (args: {
									prompt: string;
									maxTokens?: number;
								}) => {
									prompts.push(args.prompt);
									requests.push(args);
									return completion;
								},
							}
						: null,
				getSetting: () => undefined,
			} as never,
		};
	}

	it("is present in the plugin model map and produces a structurally valid result", async () => {
		const handlers = createLocalInferenceModelHandlers();
		const handler = handlers[ModelType.PII_SCRUB];
		expect(typeof handler).toBe("function");
		const { runtime, prompts, requests } = runtimeWithBackend(
			`[{"span":"Alice Johnson","verdict":"pii","replacement":"Nora Vane","cluster":"entity:e1"},
			  {"span":"Acme Corp","verdict":"safe"}]`,
		);
		const result = await (
			handler as (r: unknown, p: PiiScrubParams) => Promise<unknown>
		)(runtime, PARAMS);
		expect(prompts).toHaveLength(1);
		expect(requests[0]?.maxTokens).toBeUndefined();
		expect(result).toMatchObject({
			rulesetVersion: "2026.08",
			modelId: expect.stringContaining("eliza-local-inference"),
		});
		const verdicts = (result as { verdicts: { span: string }[] }).verdicts;
		expect(verdicts).toHaveLength(2);
	});

	it("fails closed when no local backend is active", async () => {
		const handlers = createLocalInferenceModelHandlers();
		const handler = handlers[ModelType.PII_SCRUB] as (
			r: unknown,
			p: PiiScrubParams,
		) => Promise<unknown>;
		await expect(
			handler({ getService: () => null } as never, PARAMS),
		).rejects.toThrow(/local inference backend/i);
	});
});
