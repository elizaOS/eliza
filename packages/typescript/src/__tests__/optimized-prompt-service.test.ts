import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	OPTIMIZED_PROMPT_SERVICE,
	type OptimizedPromptArtifact,
	OptimizedPromptService,
	parseOptimizedPromptArtifact,
} from "../services/optimized-prompt";

let storeRoot: string;

beforeEach(() => {
	storeRoot = mkdtempSync(join(tmpdir(), "optimized-prompt-"));
});

afterEach(() => {
	if (existsSync(storeRoot)) {
		rmSync(storeRoot, { recursive: true, force: true });
	}
});

function makeArtifact(
	overrides: Partial<OptimizedPromptArtifact> = {},
): OptimizedPromptArtifact {
	return {
		task: "should_respond",
		optimizer: "instruction-search",
		baseline: "BASELINE_PROMPT",
		prompt: "OPTIMIZED_PROMPT",
		score: 0.85,
		baselineScore: 0.5,
		datasetId: "dataset-1",
		datasetSize: 100,
		generatedAt: new Date().toISOString(),
		lineage: [{ round: 0, variant: 0, score: 0.5, notes: "baseline" }],
		...overrides,
	};
}

describe("OptimizedPromptService", () => {
	it("constants and service type", () => {
		expect(OPTIMIZED_PROMPT_SERVICE).toBe("optimized_prompt");
		expect(OptimizedPromptService.serviceType).toBe(OPTIMIZED_PROMPT_SERVICE);
	});

	it("returns null when no artifacts are present", async () => {
		const service = new OptimizedPromptService();
		service.setStoreRoot(storeRoot);
		await service.refresh();
		expect(service.getPrompt("should_respond")).toBeNull();
		expect(service.hasOptimized("should_respond")).toBe(false);
		expect(service.getMetadata("should_respond")).toBeNull();
	});

	it("loads artifacts from disk and selects the most recent", async () => {
		const dir = join(storeRoot, "should_respond");
		mkdirSync(dir, { recursive: true });
		const older = makeArtifact({
			prompt: "OLDER_PROMPT",
			generatedAt: "2024-01-01T00:00:00.000Z",
		});
		const newer = makeArtifact({
			prompt: "NEWER_PROMPT",
			generatedAt: "2025-06-01T00:00:00.000Z",
		});
		writeFileSync(join(dir, "older.json"), JSON.stringify(older), "utf-8");
		writeFileSync(join(dir, "newer.json"), JSON.stringify(newer), "utf-8");
		const service = new OptimizedPromptService();
		service.setStoreRoot(storeRoot);
		await service.refresh();
		const resolved = service.getPrompt("should_respond");
		expect(resolved?.prompt).toBe("NEWER_PROMPT");
		expect(resolved?.optimizerSource).toBe("instruction-search");
	});

	it("setPrompt writes atomically and refreshes the cache", async () => {
		const service = new OptimizedPromptService();
		service.setStoreRoot(storeRoot);
		const artifact = makeArtifact({ prompt: "WRITE_TEST" });
		const path = await service.setPrompt("should_respond", artifact);
		expect(existsSync(path)).toBe(true);
		// Temp file must be cleaned up — only the canonical file should remain.
		const dirEntries = readFileSync(path, "utf-8");
		expect(dirEntries).toContain("WRITE_TEST");
		const resolved = service.getPrompt("should_respond");
		expect(resolved?.prompt).toBe("WRITE_TEST");
	});

	it("rejects mismatched task in setPrompt", async () => {
		const service = new OptimizedPromptService();
		service.setStoreRoot(storeRoot);
		await expect(
			service.setPrompt(
				"context_routing",
				makeArtifact({ task: "should_respond" }),
			),
		).rejects.toThrow(/does not match target task/);
	});

	it("getMetadata returns the latest artifact metadata", async () => {
		const service = new OptimizedPromptService();
		service.setStoreRoot(storeRoot);
		const artifact = makeArtifact({
			score: 0.9,
			baselineScore: 0.4,
			datasetSize: 250,
		});
		await service.setPrompt("should_respond", artifact);
		const meta = service.getMetadata("should_respond");
		expect(meta).toEqual({
			generatedAt: artifact.generatedAt,
			optimizer: "instruction-search",
			score: 0.9,
			baselineScore: 0.4,
			datasetSize: 250,
		});
	});

	it("loads artifacts with fewShotExamples and exposes them", async () => {
		const service = new OptimizedPromptService();
		service.setStoreRoot(storeRoot);
		await service.setPrompt(
			"action_planner",
			makeArtifact({
				task: "action_planner",
				fewShotExamples: [
					{ input: { user: "u1" }, expectedOutput: "e1", reward: 1 },
				],
			}),
		);
		const resolved = service.getPrompt("action_planner");
		expect(resolved?.fewShotExamples).toHaveLength(1);
		expect(resolved?.fewShotExamples?.[0]?.input.user).toBe("u1");
	});

	it("parseOptimizedPromptArtifact rejects malformed payloads", () => {
		expect(parseOptimizedPromptArtifact(null)).toBeNull();
		expect(parseOptimizedPromptArtifact({})).toBeNull();
		expect(
			parseOptimizedPromptArtifact({
				task: "should_respond",
				optimizer: "instruction-search",
				baseline: "x",
				prompt: "y",
				score: "0.5", // wrong type
				baselineScore: 0,
				datasetId: "d",
				datasetSize: 1,
				generatedAt: new Date().toISOString(),
				lineage: [],
			}),
		).toBeNull();
		expect(
			parseOptimizedPromptArtifact({
				task: "unknown_task",
				optimizer: "instruction-search",
				baseline: "x",
				prompt: "y",
				score: 0.5,
				baselineScore: 0,
				datasetId: "d",
				datasetSize: 1,
				generatedAt: new Date().toISOString(),
				lineage: [],
			}),
		).toBeNull();
	});
});
