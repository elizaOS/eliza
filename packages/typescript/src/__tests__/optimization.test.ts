import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { ScoreCard } from "../optimization/score-card.ts";
import { mergeArtifactIntoPrompt, isMergedTemplate, stripMergedContent } from "../optimization/merge.ts";
import { PromptArtifactResolver } from "../optimization/resolver.ts";
import { TraceWriter } from "../optimization/trace-writer.ts";
import { analyzeAB, selectVariant } from "../optimization/ab-analysis.ts";
import type { ExecutionTrace, OptimizedPromptArtifact } from "../optimization/types.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
	const scoreCard = new ScoreCard();
	scoreCard.add({ source: "dpe", kind: "parseSuccess", value: 1.0 });
	return {
		id: `trace-${Math.random().toString(36).slice(2)}`,
		traceVersion: 1,
		type: "trace",
		promptKey: "testPrompt",
		modelSlot: "TEXT_SMALL",
		modelId: "gpt-4o-mini",
		templateHash: "abc123",
		schemaFingerprint: "def456",
		variant: "baseline",
		parseSuccess: true,
		schemaValid: true,
		validationCodesMatched: true,
		retriesUsed: 0,
		tokenEstimate: 100,
		latencyMs: 500,
		scoreCard: scoreCard.toJSON(),
		createdAt: Date.now(),
		...overrides,
	};
}

function makeArtifact(overrides: Partial<OptimizedPromptArtifact> = {}): OptimizedPromptArtifact {
	return {
		version: Date.now(),
		instructions: "Be concise and accurate.",
		demos: "Example 1:\n  field: value",
		playbook: "- Always verify facts\n- Keep responses under 200 words",
		pipeline: {
			stages: [],
			totalDurationMs: 1000,
			baselineScore: 0.7,
			finalScore: 0.85,
		},
		abConfig: {
			trafficSplit: 0.5,
			minSamples: 3,
			significanceThreshold: 0.05,
		},
		promotionHistory: [{ action: "created", timestamp: Date.now(), compositeScore: 0.85 }],
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// ScoreCard tests
// ---------------------------------------------------------------------------

describe("ScoreCard", () => {
	it("computes weighted composite score", () => {
		const card = new ScoreCard();
		card.add({ source: "dpe", kind: "parseSuccess", value: 1.0 });
		card.add({ source: "dpe", kind: "schemaValid", value: 0.5 });

		// With default weights (parseSuccess=3.0, schemaValid=2.0):
		// (1.0 * 3.0 + 0.5 * 2.0) / (3.0 + 2.0) = 4.0 / 5.0 = 0.8
		const score = card.composite();
		expect(score).toBeCloseTo(0.8, 5);
	});

	it("applies per-signal weight override", () => {
		const card = new ScoreCard();
		card.add({ source: "dpe", kind: "parseSuccess", value: 1.0, weight: 10.0 });
		card.add({ source: "dpe", kind: "schemaValid", value: 0.0, weight: 1.0 });

		const score = card.composite();
		expect(score).toBeCloseTo(10.0 / 11.0, 5);
	});

	it("applies weightOverrides parameter", () => {
		const card = new ScoreCard();
		card.add({ source: "dpe", kind: "parseSuccess", value: 1.0 });
		card.add({ source: "dpe", kind: "schemaValid", value: 0.0 });

		// Override both to weight 1 -> (1.0 + 0.0) / 2 = 0.5
		const score = card.composite({ "dpe:parseSuccess": 1.0, "dpe:schemaValid": 1.0 });
		expect(score).toBeCloseTo(0.5, 5);
	});

	it("returns 0 for empty card", () => {
		const card = new ScoreCard();
		expect(card.composite()).toBe(0);
	});

	it("round-trips through toJSON/fromJSON", () => {
		const card = new ScoreCard();
		card.add({ source: "neuro", kind: "reaction_positive", value: 1.0 });
		card.add({ source: "dpe", kind: "parseSuccess", value: 0.8 });

		const restored = ScoreCard.fromJSON(card.toJSON());
		expect(restored.composite()).toBeCloseTo(card.composite(), 5);
		expect(restored.signals).toHaveLength(2);
	});

	it("filters by source and kind", () => {
		const card = new ScoreCard();
		card.add({ source: "dpe", kind: "parseSuccess", value: 1.0 });
		card.add({ source: "neuro", kind: "reaction_positive", value: 0.9 });
		card.add({ source: "dpe", kind: "schemaValid", value: 0.8 });

		expect(card.bySource("dpe")).toHaveLength(2);
		expect(card.bySource("neuro")).toHaveLength(1);
		expect(card.byKind("parseSuccess")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// mergeArtifactIntoPrompt tests
// ---------------------------------------------------------------------------

describe("mergeArtifactIntoPrompt", () => {
	const baseTemplate = "You are a helpful assistant.\n\nAnswer: {{userMessage}}";

	it("prepends all three sections when populated", () => {
		const artifact = makeArtifact();
		const merged = mergeArtifactIntoPrompt(baseTemplate, artifact);

		expect(merged).toContain("[OPTIMIZED PLAYBOOK]");
		expect(merged).toContain("[OPTIMIZED INSTRUCTIONS]");
		expect(merged).toContain("[OPTIMIZED EXAMPLES]");
		expect(merged).toContain(baseTemplate);
	});

	it("places optimized content before the original template", () => {
		const artifact = makeArtifact();
		const merged = mergeArtifactIntoPrompt(baseTemplate, artifact);
		const optimizedIdx = merged.indexOf("[OPTIMIZED PLAYBOOK]");
		const templateIdx = merged.indexOf("You are a helpful assistant.");
		expect(optimizedIdx).toBeLessThan(templateIdx);
	});

	it("returns original template unchanged when artifact has no content", () => {
		const artifact = makeArtifact({ instructions: "", demos: "", playbook: "" });
		const merged = mergeArtifactIntoPrompt(baseTemplate, artifact);
		expect(merged).toBe(baseTemplate);
	});

	it("only includes non-empty sections", () => {
		const artifact = makeArtifact({ demos: "" });
		const merged = mergeArtifactIntoPrompt(baseTemplate, artifact);
		expect(merged).toContain("[OPTIMIZED PLAYBOOK]");
		expect(merged).toContain("[OPTIMIZED INSTRUCTIONS]");
		expect(merged).not.toContain("[OPTIMIZED EXAMPLES]");
	});

	it("isMergedTemplate detects merged content", () => {
		const artifact = makeArtifact();
		const merged = mergeArtifactIntoPrompt(baseTemplate, artifact);
		expect(isMergedTemplate(merged)).toBe(true);
		expect(isMergedTemplate(baseTemplate)).toBe(false);
	});

	it("stripMergedContent restores original template", () => {
		const artifact = makeArtifact();
		const merged = mergeArtifactIntoPrompt(baseTemplate, artifact);
		const stripped = stripMergedContent(merged);
		expect(stripped).toBe(baseTemplate);
	});
});

// ---------------------------------------------------------------------------
// PromptArtifactResolver tests
// ---------------------------------------------------------------------------

describe("PromptArtifactResolver", () => {
	let tempDir: string;
	let resolver: PromptArtifactResolver;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "opt-test-"));
		resolver = new PromptArtifactResolver(tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("returns null for non-existent artifact", async () => {
		const result = await resolver.resolve("gpt-4o-mini", "TEXT_SMALL", "testPrompt");
		expect(result).toBeNull();
	});

	it("writes and reads artifact round-trip", async () => {
		const artifact = makeArtifact();
		await resolver.writeArtifact("gpt-4o-mini", "TEXT_SMALL", "testPrompt", artifact);
		const result = await resolver.resolve("gpt-4o-mini", "TEXT_SMALL", "testPrompt");

		expect(result).not.toBeNull();
		expect(result?.instructions).toBe(artifact.instructions);
		expect(result?.demos).toBe(artifact.demos);
		expect(result?.playbook).toBe(artifact.playbook);
	});

	it("merges multiple prompt keys in the same artifact file", async () => {
		const a1 = makeArtifact({ instructions: "Instructions for A" });
		const a2 = makeArtifact({ instructions: "Instructions for B" });

		await resolver.writeArtifact("gpt-4o-mini", "TEXT_SMALL", "promptA", a1);
		await resolver.writeArtifact("gpt-4o-mini", "TEXT_SMALL", "promptB", a2);

		const rA = await resolver.resolve("gpt-4o-mini", "TEXT_SMALL", "promptA");
		const rB = await resolver.resolve("gpt-4o-mini", "TEXT_SMALL", "promptB");

		expect(rA?.instructions).toBe("Instructions for A");
		expect(rB?.instructions).toBe("Instructions for B");
	});

	it("separates artifacts by model ID", async () => {
		const a1 = makeArtifact({ instructions: "For GPT" });
		const a2 = makeArtifact({ instructions: "For Llama" });

		await resolver.writeArtifact("gpt-4o-mini", "TEXT_SMALL", "p", a1);
		await resolver.writeArtifact("llama3__8b", "TEXT_SMALL", "p", a2);

		const rGpt = await resolver.resolve("gpt-4o-mini", "TEXT_SMALL", "p");
		const rLlama = await resolver.resolve("llama3__8b", "TEXT_SMALL", "p");

		expect(rGpt?.instructions).toBe("For GPT");
		expect(rLlama?.instructions).toBe("For Llama");
	});

	it("invalidate clears the in-memory cache", async () => {
		const artifact = makeArtifact();
		await resolver.writeArtifact("gpt-4o-mini", "TEXT_SMALL", "p", artifact);

		// Read once to populate cache
		await resolver.resolve("gpt-4o-mini", "TEXT_SMALL", "p");

		// Invalidate
		resolver.invalidate("gpt-4o-mini", "TEXT_SMALL");

		// Should still read correctly from disk
		const result = await resolver.resolve("gpt-4o-mini", "TEXT_SMALL", "p");
		expect(result).not.toBeNull();
	});

	it("resolveWithAB returns baseline when trafficSplit=0", async () => {
		const artifact = makeArtifact({ abConfig: { trafficSplit: 0.0, minSamples: 3, significanceThreshold: 0.05 } });
		await resolver.writeArtifact("gpt-4o-mini", "TEXT_SMALL", "p", artifact);

		for (let i = 0; i < 10; i++) {
			const result = await resolver.resolveWithAB("gpt-4o-mini", "TEXT_SMALL", "p", i);
			expect(result.selectedVariant).toBe("baseline");
		}
	});

	it("resolveWithAB returns optimized when trafficSplit=1", async () => {
		const artifact = makeArtifact({ abConfig: { trafficSplit: 1.0, minSamples: 3, significanceThreshold: 0.05 } });
		await resolver.writeArtifact("gpt-4o-mini", "TEXT_SMALL", "p", artifact);

		for (let i = 0; i < 10; i++) {
			const result = await resolver.resolveWithAB("gpt-4o-mini", "TEXT_SMALL", "p", i);
			expect(result.selectedVariant).toBe("optimized");
		}
	});
});

// ---------------------------------------------------------------------------
// TraceWriter tests
// ---------------------------------------------------------------------------

describe("TraceWriter", () => {
	let tempDir: string;
	let writer: TraceWriter;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "tw-test-"));
		writer = new TraceWriter(tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("appends traces and reads them back", async () => {
		const t1 = makeTrace({ id: "t1" });
		const t2 = makeTrace({ id: "t2", promptKey: "other" });

		await writer.appendTrace("gpt-4o-mini", "TEXT_SMALL", t1);
		await writer.appendTrace("gpt-4o-mini", "TEXT_SMALL", t2);

		const all = await writer.loadTraces("gpt-4o-mini", "TEXT_SMALL");
		expect(all).toHaveLength(2);
	});

	it("filters traces by promptKey", async () => {
		const t1 = makeTrace({ id: "t1", promptKey: "promptA" });
		const t2 = makeTrace({ id: "t2", promptKey: "promptB" });

		await writer.appendTrace("gpt-4o-mini", "TEXT_SMALL", t1);
		await writer.appendTrace("gpt-4o-mini", "TEXT_SMALL", t2);

		const filtered = await writer.loadTracesForPrompt("gpt-4o-mini", "TEXT_SMALL", "promptA");
		expect(filtered).toHaveLength(1);
		expect(filtered[0].id).toBe("t1");
	});

	it("returns empty array when no traces exist", async () => {
		const traces = await writer.loadTraces("nonexistent", "TEXT_SMALL");
		expect(traces).toHaveLength(0);
	});

	it("creates directories automatically", async () => {
		const trace = makeTrace();
		// Should not throw even though directories don't exist
		await expect(writer.appendTrace("new-model", "TEXT_MEGA", trace)).resolves.not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// A/B Analysis tests
// ---------------------------------------------------------------------------

describe("analyzeAB", () => {
	const minSamples = 3;

	function makeTraces(count: number, scoreValue: number, variant: string): ExecutionTrace[] {
		return Array.from({ length: count }, (_, i) => {
			const card = new ScoreCard();
			card.add({ source: "dpe", kind: "parseSuccess", value: scoreValue });
			return makeTrace({
				id: `${variant}-${i}`,
				variant,
				scoreCard: card.toJSON(),
			});
		});
	}

	it("returns inconclusive with insufficient samples", () => {
		const baseline = makeTraces(2, 0.7, "baseline");
		const optimized = makeTraces(2, 0.9, "optimized");
		const result = analyzeAB(baseline, optimized, 0.05, minSamples);
		expect(result.action).toBe("inconclusive");
	});

	it("promotes when optimized clearly wins", () => {
		// Large samples with clear difference -> should promote
		const baseline = makeTraces(100, 0.5, "baseline");
		const optimized = makeTraces(100, 0.95, "optimized");
		const result = analyzeAB(baseline, optimized, 0.05, minSamples);
		expect(result.action).toBe("promote");
		expect(result.optimizedScore).toBeGreaterThan(result.baselineScore);
	});

	it("rolls back when baseline clearly wins", () => {
		const baseline = makeTraces(100, 0.95, "baseline");
		const optimized = makeTraces(100, 0.5, "optimized");
		const result = analyzeAB(baseline, optimized, 0.05, minSamples);
		expect(result.action).toBe("rollback");
		expect(result.baselineScore).toBeGreaterThan(result.optimizedScore);
	});

	it("is inconclusive with very similar scores", () => {
		// Same scores -> p-value will be 1.0
		const baseline = makeTraces(10, 0.75, "baseline");
		const optimized = makeTraces(10, 0.75, "optimized");
		const result = analyzeAB(baseline, optimized, 0.05, minSamples);
		expect(result.action).toBe("inconclusive");
	});
});

describe("selectVariant", () => {
	it("always returns baseline when trafficSplit=0", () => {
		for (let i = 0; i < 20; i++) {
			expect(selectVariant(0, "testPrompt", i)).toBe("baseline");
		}
	});

	it("always returns optimized when trafficSplit=1", () => {
		for (let i = 0; i < 20; i++) {
			expect(selectVariant(1, "testPrompt", i)).toBe("optimized");
		}
	});

	it("splits traffic roughly 50/50 at trafficSplit=0.5", () => {
		let optimizedCount = 0;
		const N = 1000;
		for (let i = 0; i < N; i++) {
			if (selectVariant(0.5, "testPrompt", i) === "optimized") optimizedCount++;
		}
		// Should be roughly 50% within reasonable tolerance (±10%)
		expect(optimizedCount / N).toBeGreaterThan(0.4);
		expect(optimizedCount / N).toBeLessThan(0.6);
	});

	it("is deterministic for same seed", () => {
		const v1 = selectVariant(0.5, "myPrompt", 42);
		const v2 = selectVariant(0.5, "myPrompt", 42);
		expect(v1).toBe(v2);
	});
});

// ---------------------------------------------------------------------------
// Integration test
// ---------------------------------------------------------------------------

describe("Optimization integration", () => {
	let tempDir: string;
	let resolver: PromptArtifactResolver;
	let writer: TraceWriter;

	beforeEach(async () => {
		tempDir = await mkdtemp(join(tmpdir(), "opt-integration-"));
		resolver = new PromptArtifactResolver(tempDir);
		writer = new TraceWriter(tempDir);
	});

	afterEach(async () => {
		await rm(tempDir, { recursive: true, force: true });
	});

	it("end-to-end: write traces, write artifact, resolve and merge", async () => {
		const modelId = "gpt-4o-mini";
		const slotKey = "TEXT_SMALL";
		const promptKey = "integrationTest";

		// Write some traces
		for (let i = 0; i < 5; i++) {
			await writer.appendTrace(modelId, slotKey, makeTrace({ id: `t${i}`, promptKey }));
		}

		// Simulate optimization output
		const artifact = makeArtifact({
			instructions: "Be very precise and cite sources.",
			demos: "Example 1:\n  answer: Paris",
			playbook: "- Never guess\n- Always verify",
			abConfig: { trafficSplit: 1.0, minSamples: 3, significanceThreshold: 0.05 },
		});
		await resolver.writeArtifact(modelId, slotKey, promptKey, artifact);

		// Resolve should return the artifact
		const resolved = await resolver.resolve(modelId, slotKey, promptKey);
		expect(resolved).not.toBeNull();

		// Merge should produce an optimized template
		const baseTemplate = "Answer: {{question}}";
		const merged = mergeArtifactIntoPrompt(baseTemplate, resolved!);

		expect(isMergedTemplate(merged)).toBe(true);
		expect(merged).toContain("Be very precise");
		expect(merged).toContain("Never guess");
		expect(merged).toContain("Answer: {{question}}");

		// A/B with trafficSplit=1 should always return optimized
		const { selectedVariant } = await resolver.resolveWithAB(modelId, slotKey, promptKey);
		expect(selectedVariant).toBe("optimized");

		// Load traces from disk
		const loaded = await writer.loadTracesForPrompt(modelId, slotKey, promptKey);
		expect(loaded).toHaveLength(5);
	});
});
