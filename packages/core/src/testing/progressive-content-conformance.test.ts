/** Exercises Unicode traversal and real negative conformance vectors. */

import { describe, expect, it } from "vitest";
import {
	progressiveConformanceAdapter,
	progressiveConformanceFixture,
} from "./progressive-content-conformance.fixture";
import { runProgressiveContentConformance } from "./progressive-content-conformance";

describe("progressive content conformance", () => {
	it("proves traversal, restart, repeats, cleanup, and bounded work", async () => {
		const { object } = progressiveConformanceFixture();
		const report = await runProgressiveContentConformance({
			adapter: progressiveConformanceAdapter(),
			object,
			performanceCeilings: { maxDatabaseGrowthBytes: 0 },
		});
		expect(report).toMatchObject({
			status: "passed",
			reassembledSha256: object.sourceSha256,
			restartVerified: true,
			concurrencyVerified: true,
			repeatedPageVerified: true,
			cleanupVerified: true,
			postCleanupProbeVerified: true,
		});
		expect(report.canariesFound).toEqual([
			"beginning",
			"boundary",
			"end",
			"middle",
		]);
		expect(report.sourceWork).toMatchObject({
			bytesRead: object.byteLength,
			rowsRead: report.pages,
			parentScans: 0,
		});
	});

	it("rejects an adapter that only claims cleanup", async () => {
		const { object } = progressiveConformanceFixture();
		const base = progressiveConformanceAdapter();
		const report = await runProgressiveContentConformance({
			object,
			adapter: { ...base, async cleanup() {} },
		});
		expect(report.status).toBe("failed");
		expect(report.failures.map(({ vector }) => vector)).toContain("cleanup");
		expect(report.postCleanupProbeVerified).toBe(false);
	});
});
