/** Verifies benchmark traversal, cold/warm separation, distributions, and exact fresh-process matrix enforcement. */

import { describe, expect, it } from "vitest";
import {
	buildProgressiveContentBenchmarkReport,
	type ProgressiveContentBenchmarkProcessSample,
	type ProgressiveContentBenchmarkResourceSample,
	progressiveContentBenchmarkDistribution,
	runProgressiveContentBenchmarkProcessSample,
} from "./progressive-content-benchmark";
import {
	progressiveConformanceAdapter,
	progressiveConformanceFixture,
} from "./progressive-content-conformance.fixture";
import type { ProgressiveContentTarget } from "./progressive-content-target";

const stable: ProgressiveContentBenchmarkResourceSample = {
	rssBytes: 100,
	heapUsedBytes: 50,
	externalBytes: 20,
	arrayBuffersBytes: 10,
	fileDescriptors: 4,
	databaseBytes: 1_000,
	databaseRows: 1,
	walBytes: 0,
};

function target(): ProgressiveContentTarget {
	const adapter = progressiveConformanceAdapter();
	const { object } = progressiveConformanceFixture();
	return {
		family: "file",
		object,
		realization: {
			reference: {
				kind: "file",
				ref: "file:fixture",
				revision: object.revision,
			},
			sourceRevision: object.revision,
			authorizationMode: "principal",
			restartScope: "process",
			authorizationScopeDigest: "a".repeat(64),
			cleanupIdentity: "fixture",
			resolverBindingSha256: object.sourceSha256,
		},
		read: ({ access, ...request }) =>
			adapter.read({
				...request,
				objectId: object.id,
				authorizationScope:
					access === "authorized" ? object.authorizationScope : "denied",
			}),
		restart: () => adapter.restart(),
		inspect: async () => ({
			resolverGeneration: "fixture",
			present: true,
			ownedBytes: object.byteLength,
			databaseRows: 1,
			temporaryArtifacts: 0,
			walBytes: 0,
		}),
		cleanup: () => adapter.cleanup(object.id),
	};
}

describe("progressive content benchmark", () => {
	it("records complete cold and warm traversals with every resource dimension", async () => {
		const fixture = progressiveConformanceFixture();
		let measurement = 0;
		const sample = await runProgressiveContentBenchmarkProcessSample({
			family: "file",
			adapterId: "native-file-reader",
			productionMethod: "bounded-file-read",
			sourceBytes: fixture.object.byteLength,
			repetition: 1,
			processId: 101,
			freshProcess: true,
			createTarget: async () => target(),
			measureResources: () => ({
				...stable,
				rssBytes: stable.rssBytes + measurement++,
				databaseBytes: stable.databaseBytes + measurement,
				walBytes: measurement,
			}),
		});
		expect(sample.cold.bytesReturned).toBe(fixture.object.byteLength);
		expect(sample.warm.bytesReturned).toBe(fixture.object.byteLength);
		expect(sample.cold.pages).toBeGreaterThan(1);
		expect(sample.cold.pageLatencyMs).toEqual(
			expect.objectContaining({
				p50: expect.any(Number),
				p95: expect.any(Number),
				p99: expect.any(Number),
				maximum: expect.any(Number),
			}),
		);
		expect(sample.cold.pageLatencySamplesMs).toHaveLength(sample.cold.pages);
		expect(sample.cold.instrumentationMs).toBeGreaterThanOrEqual(0);
		expect(sample.warm.resourceGrowth).toEqual(
			expect.objectContaining({
				rssBytes: expect.any(Number),
				heapUsedBytes: expect.any(Number),
				externalBytes: expect.any(Number),
				arrayBuffersBytes: expect.any(Number),
				fileDescriptors: expect.any(Number),
				databaseBytes: expect.any(Number),
				databaseRows: expect.any(Number),
				walBytes: expect.any(Number),
			}),
		);
	});

	it("uses observed nearest-rank percentiles", () => {
		expect(progressiveContentBenchmarkDistribution([5, 1, 4, 2, 3])).toEqual({
			p50: 3,
			p95: 5,
			p99: 5,
			maximum: 5,
		});
	});

	it("rejects missing, duplicate, reused-process, and non-isolated samples", () => {
		const phase = {
			phase: "cold" as const,
			elapsedMs: 1,
			instrumentationMs: 0,
			throughputBytesPerSecond: 1,
			pageLatencySamplesMs: [1],
			pageLatencyMs: { p50: 1, p95: 1, p99: 1, maximum: 1 },
			pages: 1,
			bytesReturned: 1,
			sourceWork: { bytesRead: 1, readCalls: 1, rowsRead: 1, parentScans: 0 },
			resourceGrowth: stable,
		};
		const sample: ProgressiveContentBenchmarkProcessSample = {
			family: "file",
			adapterId: "native-file-reader",
			productionMethod: "bounded-file-read",
			sourceBytes: 1,
			repetition: 1,
			processId: 7,
			freshProcess: false,
			setupGrowth: stable,
			cold: phase,
			warm: { ...phase, phase: "warm" },
		};
		const report = buildProgressiveContentBenchmarkReport({
			families: ["file"],
			sourceSizes: [1, 2],
			repetitions: 2,
			samples: [sample, sample],
		});
		expect(report.status).toBe("failed");
		expect(report.evidenceEligible).toBe(false);
		expect(report.failures).toEqual(
			expect.arrayContaining([
				"sample file:1:1 was not process-isolated",
				"duplicate sample file:1:1",
				"process 7 was reused",
				"missing sample file:1:2",
				"missing sample file:2:1",
				"missing sample file:2:2",
			]),
		);
	});

	it("requires all ninety family-size-repetition coordinates for evidence", () => {
		const report = buildProgressiveContentBenchmarkReport({ samples: [] });
		expect(report.status).toBe("failed");
		expect(report.evidenceEligible).toBe(false);
		expect(report.failures).toHaveLength(90);
		expect(report.cases).toHaveLength(18);
		expect(report.failures).toContain("missing sample tool-output:104857600:5");
	});
});
