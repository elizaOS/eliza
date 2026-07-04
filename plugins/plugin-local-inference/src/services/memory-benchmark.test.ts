/** Covers the resident-memory benchmark report planner against synthetic catalog/probe data. Deterministic. */
import { MODEL_CATALOG } from "@elizaos/shared/local-inference";
import { describe, expect, it } from "vitest";
import {
	buildMemoryBenchmarkPlan,
	buildMemoryBenchmarkReport,
	summarizeMemoryBenchmark,
} from "./memory-benchmark";
import type { HardwareProbe, InstalledModel } from "./types";

function hardware(freeRamGb: number): HardwareProbe {
	return {
		totalRamGb: 16,
		freeRamGb,
		gpu: null,
		cpuCores: 8,
		platform: "darwin",
		arch: "arm64",
		appleSilicon: true,
		recommendedBucket: "mid",
		source: "os-fallback",
	};
}

describe("memory benchmark report", () => {
	it("marks the device-fit Eliza-1 tier and records curated resident estimates", () => {
		const plan = buildMemoryBenchmarkPlan({
			catalog: MODEL_CATALOG,
			installed: [
				{
					id: "eliza-1-2b",
					displayName: "Eliza-1 2B",
					path: "/tmp/eliza-1-2b.bundle/text/eliza-1-2b-128k.gguf",
					sizeBytes: 1_500_000_000,
					bundleRoot: "/tmp/eliza-1-2b.bundle",
					bundleSizeBytes: 2_000_000_000,
					source: "eliza-download",
					installedAt: "2026-06-22T00:00:00.000Z",
					lastUsedAt: null,
				} satisfies InstalledModel,
			],
			hardware: hardware(4.5),
		});

		const twoB = plan.find((model) => model.modelId === "eliza-1-2b");
		expect(twoB?.installed).toBe(true);
		expect(twoB?.selectedByDeviceFit).toBe(true);
		// Gemma 4 cutover: KV is stock q8_0 (Gemma's MQA + windowed-SWA +
		// shared-KV is already minimal; the head_dim=128 QJL kernel is retired).
		expect(twoB?.plannedKvQuant).toBe("q8_0");
		expect(twoB?.estimatedResidentMb).toBeGreaterThan(0);

		const larger = plan.find((model) => model.modelId === "eliza-1-9b");
		expect(larger?.fit).toBe("tight");
		expect(larger?.selectedByDeviceFit).toBe(false);

		const largest = plan.find((model) => model.modelId === "eliza-1-27b-256k");
		expect(largest?.fit).toBe("wontfit");
	});

	it("summarizes load and telemetry counts", async () => {
		const report = await buildMemoryBenchmarkReport(
			{
				catalog: MODEL_CATALOG,
				installed: [],
				hardware: hardware(2),
			},
			[
				{
					type: "model_load",
					capability: "text",
					modelKey: "m",
					loadMs: 3,
					atMs: 1,
				},
				{
					type: "eviction",
					capability: "text",
					modelKey: "m",
					reason: "fit",
					estimatedMb: 512,
					atMs: 2,
				},
			],
		);

		expect(report.deviceFit.modelId).toBeNull();
		expect(report.telemetry.modelLoads).toBe(1);
		expect(report.telemetry.evictions).toBe(1);
		expect(summarizeMemoryBenchmark(report)).toContain("cloud fallback");
	});
});
