/** Exercises real concurrent adapter calls, resource deltas, soak thresholds, and leak controls. */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ProgressiveContentConformanceAdapter } from "./progressive-content-conformance";
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
import type { ProgressiveContentTarget } from "./progressive-content-target";

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

function targetFixture(
	adapter: ProgressiveContentConformanceAdapter = progressiveConformanceAdapter(),
): ProgressiveContentTarget {
	const fixture = progressiveConformanceFixture();
	let present = true;
	let generation = 1;
	return {
		family: "file",
		object: fixture.object,
		realization: {
			reference: {
				kind: "file",
				ref: "file:object-1",
				revision: fixture.object.revision,
				resumability: "restart-safe",
			},
			sourceRevision: fixture.object.revision,
			authorizationMode: "principal",
			restartScope: "process",
			authorizationScopeDigest: createHash("sha256")
				.update(fixture.object.authorizationScope)
				.digest("hex"),
			cleanupIdentity: "file:object-1",
			resolverBindingSha256: fixture.object.revision,
		},
		async read({ access, offset, limit, expectedRevision }) {
			if (access !== "authorized") throw new Error("CONTENT_ACCESS_DENIED");
			if (!present) throw new Error("CONTENT_NOT_FOUND");
			return adapter.read({
				objectId: fixture.object.id,
				authorizationScope: fixture.object.authorizationScope,
				offset,
				limit,
				expectedRevision,
			});
		},
		async restart() {
			generation += 1;
		},
		async inspect() {
			return {
				resolverGeneration: `generation:${generation}`,
				present,
				ownedBytes: present ? fixture.object.byteLength : 0,
				databaseRows: 0,
				temporaryArtifacts: 0,
				walBytes: 0,
			};
		},
		async cleanup() {
			await adapter.cleanup(fixture.object.id);
			present = false;
		},
	};
}

describe("progressive content stress", () => {
	it("measures every required concurrency without source-sized work", async () => {
		let sample = 0;
		const report = await runProgressiveContentStress({
			adapterId: "production-stress-target",
			target: targetFixture(),
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

	it("rejects self-consistent bytes that change for a repeated offset", async () => {
		const adapter = progressiveConformanceAdapter();
		const originalRead = adapter.read.bind(adapter);
		let offsetZeroReads = 0;
		adapter.read = async (request) => {
			const page = await originalRead(request);
			if (request.offset !== 0) return page;
			offsetZeroReads += 1;
			if (offsetZeroReads === 1) return page;
			const bytes = Uint8Array.from(page.bytes);
			bytes[0] = (bytes[0] ?? 0) ^ 0xff;
			return {
				...page,
				bytes,
				view: {
					...page.view,
					slice: {
						...page.view.slice,
						sliceSha256: createHash("sha256").update(bytes).digest("hex"),
					},
				},
			};
		};
		const report = await runProgressiveContentStress({
			adapterId: "production-changing-page-target",
			target: targetFixture(adapter),
			concurrency: [1, 8],
			operationsPerWorker: 2,
			measureResources: () => stableResource,
		});
		expect(report.status).toBe("failed");
		expect(report.cases[1]?.failures).not.toHaveLength(0);
	});

	it("requires the positive leak control for a passing soak", async () => {
		const passing = await runProgressiveContentSoak({
			adapterId: "production-soak-target",
			target: targetFixture(),
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
			adapterId: "production-soak-target",
			target: targetFixture(),
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
			adapterId: "production-failing-target",
			target: targetFixture(adapter),
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
