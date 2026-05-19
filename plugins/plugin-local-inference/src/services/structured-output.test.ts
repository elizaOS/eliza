import type { ResponseSkeleton } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import {
	canonicalizeShortName,
	collapseSkeleton,
	compilePrefillPlan,
	compileSkeletonToGbnf,
	elizaHarnessSchemaFromSkeleton,
	expandShortName,
	grammarRequestFields,
	prefillPlanRequestFields,
	resolveGrammarForParams,
	resolveGuidedDecodeForParams,
	splitSkeletonAtFirstFree,
} from "./structured-output";

const envelopeSkeleton: ResponseSkeleton = {
	id: "response-v1",
	spans: [
		{ kind: "literal", value: '{\n  "shouldRespond": "' },
		{
			kind: "enum",
			key: "shouldRespond",
			enumValues: ["RESPOND", "IGNORE", "STOP"],
		},
		{ kind: "literal", value: '",\n  "contexts": ' },
		{ kind: "free-json", key: "contexts" },
		{ kind: "literal", value: ',\n  "intents": ' },
		{ kind: "free-json", key: "intents" },
		{ kind: "literal", value: ',\n  "replyText": "' },
		{ kind: "free-string", key: "replyText" },
		{ kind: "literal", value: '",\n  "candidateActionNames": ' },
		{ kind: "free-json", key: "candidateActionNames" },
		{ kind: "literal", value: ',\n  "facts": ' },
		{ kind: "free-json", key: "facts" },
		{ kind: "literal", value: ',\n  "relationships": ' },
		{ kind: "free-json", key: "relationships" },
		{ kind: "literal", value: ',\n  "addressedTo": ' },
		{ kind: "free-json", key: "addressedTo" },
		{ kind: "literal", value: ',\n  "emotion": "' },
		{
			kind: "enum",
			key: "emotion",
			enumValues: ["neutral", "positive", "concerned"],
		},
		{ kind: "literal", value: '"' },
		{ kind: "literal", value: "\n}" },
	],
};

describe("collapseSkeleton (C4 — single-value enum/option skip)", () => {
	it("lowers a single-value enum to a literal", () => {
		const collapsed = collapseSkeleton({
			spans: [
				{ kind: "literal", value: '"x": "' },
				{ kind: "enum", key: "x", enumValues: ["only"] },
				{ kind: "literal", value: '"' },
			],
		});
		expect(collapsed.spans.map((s) => s.kind)).toEqual([
			"literal",
			"literal",
			"literal",
		]);
		expect(collapsed.spans[1]).toEqual({
			kind: "literal",
			key: "x",
			value: "only",
		});
	});

	it("keeps a multi-value enum as an enum span", () => {
		const collapsed = collapseSkeleton(envelopeSkeleton);
		expect(collapsed.spans.some((s) => s.kind === "enum")).toBe(true);
	});
});

describe("compileSkeletonToGbnf", () => {
	it("compiles the response envelope into a lazy GBNF with the right root", () => {
		const grammar = compileSkeletonToGbnf(envelopeSkeleton);
		expect(grammar).not.toBeNull();
		expect(grammar?.lazy).toBe(true);
		expect(grammar?.triggers).toEqual(['{\n  "shouldRespond": "']);
		// root concatenates the spans: leading literal, enum rule, more literals,
		// field JSON/string rules, then the closing literal.
		expect(grammar?.source.startsWith("root ::= ")).toBe(true);
		expect(grammar?.source).toContain("jsonvalue");
		// The enum alternation lists all three values as GBNF string literals of
		// the JSON-quoted value (i.e. `"\"RESPOND\""`).
		expect(grammar?.source).toContain('\\"RESPOND\\"');
		expect(grammar?.source).toContain('\\"IGNORE\\"');
		expect(grammar?.source).toContain('\\"STOP\\"');
	});

	it("returns null when the skeleton is all literal (nothing to sample)", () => {
		expect(
			compileSkeletonToGbnf({ spans: [{ kind: "literal", value: "{}" }] }),
		).toBeNull();
	});

	it("collapses a single-value enum span — no rule emitted for it", () => {
		const grammar = compileSkeletonToGbnf({
			spans: [
				{ kind: "literal", value: '{"a":"' },
				{ kind: "enum", key: "a", enumValues: ["fixed"] },
				{ kind: "literal", value: '","b":"' },
				{ kind: "free-string", key: "b" },
				{ kind: "literal", value: '"}' },
			],
		});
		expect(grammar).not.toBeNull();
		// The collapsed enum becomes a literal in the root; only the free-string
		// gets its own rule.
		const ruleLines =
			grammar?.source.split("\n").filter((l) => l.includes("::=")) ?? [];
		// root + exactly one free-string rule (jsonstring/freestr).
		expect(ruleLines.length).toBe(2);
	});
});

describe("resolveGrammarForParams precedence", () => {
	it("an explicit grammar string wins over a responseSkeleton", () => {
		const g = resolveGrammarForParams({
			grammar: 'root ::= "hi"',
			responseSkeleton: envelopeSkeleton,
		});
		expect(g?.source).toBe('root ::= "hi"');
		expect(g?.lazy).toBe(false);
	});

	it("falls back to compiling the responseSkeleton", () => {
		const g = resolveGrammarForParams({ responseSkeleton: envelopeSkeleton });
		expect(g?.lazy).toBe(true);
	});

	it("returns null when neither is set", () => {
		expect(resolveGrammarForParams({})).toBeNull();
		expect(resolveGrammarForParams(undefined)).toBeNull();
	});
});

describe("grammarRequestFields", () => {
	it("emits grammar + grammar_lazy + grammar_triggers for a lazy grammar", () => {
		const fields = grammarRequestFields({
			source: "root ::= rule",
			lazy: true,
			triggers: ['"shouldRespond": "'],
		});
		expect(fields.grammar).toBe("root ::= rule");
		expect(fields.grammar_lazy).toBe(true);
		expect(fields.grammar_triggers).toEqual([
			{ type: "word", value: '"shouldRespond": "' },
		]);
	});

	it("emits only grammar for a non-lazy grammar", () => {
		expect(grammarRequestFields({ source: "root ::= x" })).toEqual({
			grammar: "root ::= x",
		});
	});
});

describe("splitSkeletonAtFirstFree", () => {
	it("peels the leading literal run off as a prefill candidate", () => {
		const { prefixLiteral, rest } = splitSkeletonAtFirstFree(envelopeSkeleton);
		expect(prefixLiteral).toBe('{\n  "shouldRespond": "');
		expect(rest[0]).toEqual({
			kind: "enum",
			key: "shouldRespond",
			enumValues: ["RESPOND", "IGNORE", "STOP"],
		});
	});
});

describe("compilePrefillPlan + prefillPlanRequestFields", () => {
	it("merges adjacent literals into one deterministic run and counts free spans", () => {
		const plan = compilePrefillPlan(envelopeSkeleton);
		expect(plan).not.toBeNull();
		if (!plan) return;
		expect(plan.prefix).toBe('{\n  "shouldRespond": "');
		expect(plan.freeCount).toBe(9);
		expect(plan.runs[0]).toEqual({
			afterFreeSpan: -1,
			text: '{\n  "shouldRespond": "',
		});
		// The tail closing literal is the run after the last free span.
		expect(plan.runs[plan.runs.length - 1]).toEqual({
			afterFreeSpan: 8,
			text: '"\n}',
		});
	});

	it("the request fragment carries the plan; empty when null", () => {
		const plan = compilePrefillPlan(envelopeSkeleton);
		const fields = prefillPlanRequestFields(plan);
		expect(fields.eliza_prefill_plan).toBeDefined();
		expect(prefillPlanRequestFields(null)).toEqual({});
	});
});

describe("elizaHarnessSchemaFromSkeleton", () => {
	it("bundles the skeleton, grammar, prefill plan and name map", () => {
		const schema = elizaHarnessSchemaFromSkeleton({
			skeleton: envelopeSkeleton,
			grammar: 'root ::= "x"',
			longNames: { RESPOND: "Respond to the user" },
		});
		expect(schema.skeleton).toBe(envelopeSkeleton);
		expect(schema.grammar).toBe('root ::= "x"');
		expect(schema.prefillPlan).not.toBeNull();
		expect(schema.longNames.RESPOND).toBe("Respond to the user");
		expect(schema.id).toBe("response-v1");
	});
});

describe("resolveGuidedDecodeForParams", () => {
	it("returns the tail grammar + prefill plan + leading-run prefill for an elizaSchema", () => {
		const schema = elizaHarnessSchemaFromSkeleton({
			skeleton: envelopeSkeleton,
		});
		const out = resolveGuidedDecodeForParams({ elizaSchema: schema });
		expect(out.grammar?.lazy).toBe(false);
		expect(out.prefillPlan).not.toBeNull();
		expect(out.prefill).toBe('{\n  "shouldRespond": "');
		expect(out.grammar?.source.split("\n")[0]).toContain("enum0");
		expect(out.grammar?.source.split("\n")[0]).not.toContain(
			'"{\\n  \\"shouldRespond\\": \\""',
		);
	});

	it("prefers the schema's pre-built grammar over compiling the skeleton", () => {
		const schema = elizaHarnessSchemaFromSkeleton({
			skeleton: envelopeSkeleton,
			grammar: 'root ::= "hi"',
		});
		const out = resolveGuidedDecodeForParams({ elizaSchema: schema });
		expect(out.grammar?.source).toBe('root ::= "hi"');
		expect(out.grammar?.lazy).toBe(false);
	});

	it("uses a tail grammar when guided decode seeds the leading literal prefill", () => {
		const fullGrammar = compileSkeletonToGbnf(envelopeSkeleton);
		expect(fullGrammar).not.toBeNull();
		if (!fullGrammar) return;
		const schema = elizaHarnessSchemaFromSkeleton({
			skeleton: envelopeSkeleton,
			grammar: fullGrammar.source,
		});

		const out = resolveGuidedDecodeForParams({ elizaSchema: schema });

		expect(out.prefill).toBe('{\n  "shouldRespond": "');
		expect(out.grammar?.lazy).toBe(false);
		const root = out.grammar?.source.split("\n")[0];
		expect(root).toMatch(/^root ::= enum\d+ /);
		expect(root).not.toContain('"{\\n  \\"shouldRespond\\": \\""');
		expect(root).toContain('\\"contexts\\":');
		expect(root).toContain('\\"replyText\\":');
		expect(out.grammar?.source).toContain('\\"RESPOND\\"');
		expect(out.grammar?.source).toContain('\\"IGNORE\\"');
		expect(out.grammar?.source).toContain('\\"STOP\\"');
	});

	it("an explicit prefill on the params wins over the plan's leading run", () => {
		const schema = elizaHarnessSchemaFromSkeleton({
			skeleton: envelopeSkeleton,
		});
		const out = resolveGuidedDecodeForParams({
			elizaSchema: schema,
			prefill: "seed:",
		});
		expect(out.prefill).toBe("seed:");
	});

	it("no elizaSchema → no prefill plan (guided decode off), bare grammar still resolved", () => {
		const out = resolveGuidedDecodeForParams({ grammar: 'root ::= "x"' });
		expect(out.prefillPlan).toBeNull();
		expect(out.grammar?.source).toBe('root ::= "x"');
		expect(out.prefill).toBeNull();
	});
});

describe("short ↔ long name round-trip", () => {
	it("expands a decoded short id to its display label and back", () => {
		const schema = elizaHarnessSchemaFromSkeleton({
			skeleton: envelopeSkeleton,
			longNames: { SEND_MESSAGE: "Send a message" },
		});
		expect(expandShortName(schema, "SEND_MESSAGE")).toBe("Send a message");
		expect(canonicalizeShortName(schema, "Send a message")).toBe(
			"SEND_MESSAGE",
		);
		// Identity for an unmapped value (canonical ids are already the wire form).
		expect(expandShortName(schema, "IGNORE")).toBe("IGNORE");
		expect(canonicalizeShortName(schema, "IGNORE")).toBe("IGNORE");
		expect(expandShortName(undefined, "X")).toBe("X");
		expect(canonicalizeShortName(undefined, "X")).toBe("X");
	});
});

describe("compilePrefillPlan + prefillPlanRequestFields — tokenization", () => {
	const stubTokenize = (text: string): number[] => {
		// Simple tokenizer: return charCodes for determinism
		return Array.from(text).map((c) => c.charCodeAt(0));
	};

	it("compilePrefillPlan(skeleton) without tokenize → runs have no tokenIds", () => {
		const plan = compilePrefillPlan(envelopeSkeleton);
		expect(plan).not.toBeNull();
		if (!plan) return;
		for (const run of plan.runs) {
			expect(run.tokenIds).toBeUndefined();
		}
	});

	it("compilePrefillPlan(skeleton, { tokenize }) → each run's tokenIds matches tokenize(run.text)", () => {
		const plan = compilePrefillPlan(envelopeSkeleton, stubTokenize);
		expect(plan).not.toBeNull();
		if (!plan) return;
		for (const run of plan.runs) {
			expect(run.tokenIds).toBeDefined();
			// Verify that tokenIds match the tokenized form of the text
			expect(run.tokenIds).toEqual(stubTokenize(run.text));
		}
	});

	it("prefillPlanRequestFields includes token_ids per run when present", () => {
		const plan = compilePrefillPlan(envelopeSkeleton, stubTokenize);
		const fields = prefillPlanRequestFields(plan);
		expect(fields.eliza_prefill_plan).toBeDefined();
		const planObj = fields.eliza_prefill_plan as Record<string, unknown>;
		const runs = planObj.runs as Array<Record<string, unknown>>;
		for (const run of runs) {
			expect(run.token_ids).toBeDefined();
			expect(Array.isArray(run.token_ids)).toBe(true);
		}
	});

	it("prefillPlanRequestFields excludes token_ids field when runs have no tokenIds", () => {
		const plan = compilePrefillPlan(envelopeSkeleton); // no tokenize callback
		const fields = prefillPlanRequestFields(plan);
		expect(fields.eliza_prefill_plan).toBeDefined();
		const planObj = fields.eliza_prefill_plan as Record<string, unknown>;
		const runs = planObj.runs as Array<Record<string, unknown>>;
		for (const run of runs) {
			expect(run.token_ids).toBeUndefined();
		}
	});

	it("plan id remains stable regardless of tokenization", () => {
		const planWithout = compilePrefillPlan(envelopeSkeleton);
		const planWith = compilePrefillPlan(envelopeSkeleton, stubTokenize);
		expect(planWithout?.id).toBe(planWith?.id);
	});

	it("tokenized plan has same structure as non-tokenized (runs, freeCount, prefix all match)", () => {
		const planWithout = compilePrefillPlan(envelopeSkeleton);
		const planWith = compilePrefillPlan(envelopeSkeleton, stubTokenize);
		expect(planWithout).not.toBeNull();
		expect(planWith).not.toBeNull();
		if (!planWithout || !planWith) return;
		expect(planWith.runs.length).toBe(planWithout.runs.length);
		expect(planWith.freeCount).toBe(planWithout.freeCount);
		expect(planWith.prefix).toBe(planWithout.prefix);
		// Verify each run's text is identical
		for (let i = 0; i < planWithout.runs.length; i++) {
			expect(planWith.runs[i].text).toBe(planWithout.runs[i].text);
			expect(planWith.runs[i].afterFreeSpan).toBe(
				planWithout.runs[i].afterFreeSpan,
			);
		}
	});
});

describe("compilePrefillPlan tokenIds — mixed spans and empty literals", () => {
	const mockTokenize = (text: string): number[] => {
		// Each char maps to its code point as the "token id" — deterministic.
		return Array.from(text).map((ch) => ch.charCodeAt(0));
	};

	it("mixed literal → free-span → literal → free-span → literal: each literal run carries its own tokenIds and the free spans interrupt the run sequence", () => {
		const mixedSkeleton: ResponseSkeleton = {
			id: "mixed",
			spans: [
				{ kind: "literal", value: "A" },
				{ kind: "free-string", key: "x" },
				{ kind: "literal", value: "B" },
				{ kind: "free-string", key: "y" },
				{ kind: "literal", value: "C" },
			],
		};
		const plan = compilePrefillPlan(mixedSkeleton, mockTokenize);
		expect(plan).not.toBeNull();
		if (!plan) return;
		expect(plan.freeCount).toBe(2);
		expect(plan.runs.length).toBe(3);
		// Leading run (before any free span).
		expect(plan.runs[0]).toEqual({
			afterFreeSpan: -1,
			text: "A",
			tokenIds: [65],
		});
		// Run between the two free spans.
		expect(plan.runs[1]).toEqual({
			afterFreeSpan: 0,
			text: "B",
			tokenIds: [66],
		});
		// Tail run after the last free span.
		expect(plan.runs[2]).toEqual({
			afterFreeSpan: 1,
			text: "C",
			tokenIds: [67],
		});
		// And the prefix is the leading run's text.
		expect(plan.prefix).toBe("A");
	});

	it("does not tokenize empty literals — empty leading and tail literals are skipped, not emitted as zero-token runs", () => {
		const calls: string[] = [];
		const trackingTokenize = (text: string): number[] => {
			calls.push(text);
			return mockTokenize(text);
		};
		const skeletonWithEmpties: ResponseSkeleton = {
			id: "with-empties",
			spans: [
				{ kind: "literal", value: "" }, // empty leading
				{ kind: "free-string", key: "a" },
				{ kind: "literal", value: "X" },
				{ kind: "free-string", key: "b" },
				{ kind: "literal", value: "" }, // empty tail
			],
		};
		const plan = compilePrefillPlan(skeletonWithEmpties, trackingTokenize);
		expect(plan).not.toBeNull();
		if (!plan) return;
		// Only the non-empty literal "X" should produce a run; the empty ones
		// flush as no-ops because pending.length === 0.
		expect(plan.runs.length).toBe(1);
		expect(plan.runs[0]).toEqual({
			afterFreeSpan: 0,
			text: "X",
			tokenIds: [88],
		});
		// The tokenizer was called exactly once — on "X" — not on the empty strings.
		expect(calls).toEqual(["X"]);
		// freeCount still counts both free spans even though the surrounding
		// literals were empty.
		expect(plan.freeCount).toBe(2);
		// No leading deterministic run → empty prefix.
		expect(plan.prefix).toBe("");
	});

	it("prefillPlanRequestFields passes the tokenIds through as token_ids in the per-run HTTP payload for a mixed-span plan", () => {
		const mixedSkeleton: ResponseSkeleton = {
			id: "mixed-wire",
			spans: [
				{ kind: "literal", value: "{" },
				{ kind: "free-string", key: "p" },
				{ kind: "literal", value: "}" },
			],
		};
		const plan = compilePrefillPlan(mixedSkeleton, mockTokenize);
		expect(plan).not.toBeNull();
		const fields = prefillPlanRequestFields(plan);
		const planObj = fields.eliza_prefill_plan as Record<string, unknown>;
		const runs = planObj.runs as Array<Record<string, unknown>>;
		expect(runs.length).toBe(2);
		// Run-by-run: the wire field is `token_ids` (snake_case), value is the
		// same array the in-memory PrefillRun.tokenIds holds.
		expect(runs[0]).toMatchObject({
			after_free_span: -1,
			text: "{",
			token_ids: [123], // '{' = 0x7B = 123
		});
		expect(runs[1]).toMatchObject({
			after_free_span: 0,
			text: "}",
			token_ids: [125], // '}' = 0x7D = 125
		});
	});
});
