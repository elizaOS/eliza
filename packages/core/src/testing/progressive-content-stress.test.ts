/** Exercises real concurrent adapter calls, resource deltas, soak thresholds, and leak controls. */

import { describe, expect, it } from "vitest";
import {
	progressiveConformanceAdapter,
	progressiveConformanceFixture,
} from "./progressive-content-conformance.fixture";
import {
	analyzeProgressiveContentResourceDrift,
	REQUIRED_PROGRESSIVE_CONTENT_CONCURRENCY,
	runProgressiveContentSoak,
	runProgressiveContentStress,
} from "./progressive-content-stress";

const stableResource = {
	rssBytes: 100 * 1024 * 1024,
	heapUsedBytes: 40 * 1024 * 1024,
	externalBytes: 8 * 1024 * 1024,
	arrayBuffersBytes: 4 * 1024 * 1024,
	fileDescriptors: 12,
	temporaryArtifacts: 0,
	databaseRows: 0,
	walBytes: 0,
};

const leakingControl = () => [
	stableResource,
	{ ...stableResource, rssBytes: stableResource.rssBytes + 32 * 1024 * 1024 },
];

describe("progressive content stress", () => {
	it("measures every required concurrency without source-sized work", async () => {
		let sample = 0;
		const report = await runProgressiveContentStress({
			adapter: progressiveConformanceAdapter(),
			object: progressiveConformanceFixture().object,
			operationsPerWorker: 2,
			measureResources: () => ({
				rssBytes: 1_000 + sample,
				heapUsedBytes: 500 + sample,
				externalBytes: 100 + sample,
				arrayBuffersBytes: 50 + sample,
				fileDescriptors: 4 + sample++,
			}),
		});
		expect(report.status).toBe("passed");
		expect(report.cases.map(({ concurrency }) => concurrency)).toEqual(
			REQUIRED_PROGRESSIVE_CONTENT_CONCURRENCY,
		);
		expect(
			report.cases.every(({ sourceWork }) => sourceWork.parentScans === 0),
		).toBe(true);
		expect(report.resources.fileDescriptorGrowth).toBe(1);
	});

	it("requires the positive leak control for a passing soak", async () => {
		const passing = await runProgressiveContentSoak({
			adapter: progressiveConformanceAdapter(),
			object: progressiveConformanceFixture().object,
			requiredDurationMs: 1,
			requiredOperations: 2,
			batchOperationsPerWorker: 1,
			concurrency: 2,
			sampleEveryOperations: 1,
			warmupOperations: 0,
			measureResources: () => stableResource,
			positiveLeakControl: leakingControl,
		});
		expect(passing.status).toBe("passed");
		expect(passing.operations).toBeGreaterThanOrEqual(2);
		expect(passing.durationMs).toBeGreaterThanOrEqual(1);
		expect(passing.resourceSamples.length).toBeGreaterThanOrEqual(2);
		expect(passing.sampleEveryOperations).toBe(1);
		expect(passing.warmupOperations).toBe(0);
		expect(passing.resourceDrift.status).toBe("passed");
		expect(passing.positiveLeakControlSamples).toHaveLength(2);
		expect(passing.positiveLeakControlDrift.status).toBe("failed");

		const failed = await runProgressiveContentSoak({
			adapter: progressiveConformanceAdapter(),
			object: progressiveConformanceFixture().object,
			requiredDurationMs: 1,
			requiredOperations: 1,
			batchOperationsPerWorker: 1,
			concurrency: 1,
			sampleEveryOperations: 1,
			warmupOperations: 0,
			measureResources: () => stableResource,
			positiveLeakControl: () => [stableResource, stableResource],
		});
		expect(failed.status).toBe("failed");
		expect(failed.failures).toContain("positive leak control was not detected");
	});

	it("detects sustained memory and retained-resource growth", () => {
		const report = analyzeProgressiveContentResourceDrift({
			samples: [
				{ operation: 0, elapsedMs: 0, sample: stableResource },
				{
					operation: 1_000,
					elapsedMs: 10,
					sample: {
						...stableResource,
						rssBytes: stableResource.rssBytes + 32 * 1024 * 1024,
						fileDescriptors: 13,
						temporaryArtifacts: 1,
						databaseRows: 1,
					},
				},
			],
		});
		expect(report.status).toBe("failed");
		expect(report.failures).toEqual(
			expect.arrayContaining([
				expect.stringContaining("rss p95 growth"),
				"file descriptors grew by 1",
				"temporary artifacts grew by 1",
				"database rows grew by 1",
			]),
		);
	});

	it("retains failures from an early batch after later batches pass", async () => {
		const adapter = progressiveConformanceAdapter();
		const originalRead = adapter.read.bind(adapter);
		let reads = 0;
		adapter.read = async (request) => {
			reads += 1;
			if (reads === 1) throw new Error("injected first-batch failure");
			return originalRead(request);
		};
		const report = await runProgressiveContentSoak({
			adapter,
			object: progressiveConformanceFixture().object,
			requiredDurationMs: 5,
			requiredOperations: 4,
			batchOperationsPerWorker: 1,
			concurrency: 1,
			sampleEveryOperations: 1,
			warmupOperations: 0,
			measureResources: () => stableResource,
			positiveLeakControl: leakingControl,
		});
		expect(report.status).toBe("failed");
		expect(report.failures).toEqual(
			expect.arrayContaining([
				expect.stringContaining("injected first-batch failure"),
			]),
		);
	});
});
