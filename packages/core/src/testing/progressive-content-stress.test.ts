/** Exercises real concurrent adapter calls, resource deltas, soak thresholds, and leak controls. */

import { describe, expect, it } from "vitest";
import {
	progressiveConformanceAdapter,
	progressiveConformanceFixture,
} from "./progressive-content-conformance.fixture";
import {
	REQUIRED_PROGRESSIVE_CONTENT_CONCURRENCY,
	runProgressiveContentSoak,
	runProgressiveContentStress,
} from "./progressive-content-stress";

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
			positiveLeakControl: () => true,
		});
		expect(passing.status).toBe("passed");
		expect(passing.operations).toBeGreaterThanOrEqual(2);
		expect(passing.durationMs).toBeGreaterThanOrEqual(1);

		const failed = await runProgressiveContentSoak({
			adapter: progressiveConformanceAdapter(),
			object: progressiveConformanceFixture().object,
			requiredDurationMs: 1,
			requiredOperations: 1,
			batchOperationsPerWorker: 1,
			concurrency: 1,
			positiveLeakControl: () => false,
		});
		expect(failed.status).toBe("failed");
	});
});
