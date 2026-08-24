/** Runs repeatable concurrency and soak measurements against production progressive-content adapters. */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
	ProgressiveConformanceObject,
	ProgressiveContentConformanceAdapter,
} from "./progressive-content-conformance";

export const PROGRESSIVE_CONTENT_STRESS_SCHEMA_VERSION =
	"elizaos.progressive-content.stress.v1" as const;
export const REQUIRED_PROGRESSIVE_CONTENT_CONCURRENCY = [1, 8, 32, 64] as const;
export const REQUIRED_PROGRESSIVE_CONTENT_SOAK_DURATION_MS =
	6 * 60 * 60 * 1_000;
export const REQUIRED_PROGRESSIVE_CONTENT_SOAK_OPERATIONS = 100_000;

export interface ProgressiveContentResourceSample {
	readonly rssBytes: number;
	readonly heapUsedBytes: number;
	readonly externalBytes: number;
	readonly arrayBuffersBytes: number;
	readonly fileDescriptors?: number;
	readonly temporaryArtifacts?: number;
	readonly databaseRows?: number;
	readonly walBytes?: number;
}

export interface ProgressiveContentResourcePoint {
	readonly operation: number;
	readonly elapsedMs: number;
	readonly sample: ProgressiveContentResourceSample;
}

export interface ProgressiveContentResourceDrift {
	readonly status: "passed" | "failed";
	readonly warmupOperations: number;
	readonly memoryGrowthLimitsBytes: {
		readonly rss: number;
		readonly heap: number;
		readonly external: number;
		readonly arrayBuffers: number;
	};
	readonly rssP95GrowthBytes: number;
	readonly heapP95GrowthBytes: number;
	readonly externalP95GrowthBytes: number;
	readonly arrayBuffersP95GrowthBytes: number;
	readonly fileDescriptorGrowth?: number;
	readonly temporaryArtifactGrowth?: number;
	readonly databaseRowGrowth?: number;
	readonly walGrowthBytes?: number;
	readonly failures: readonly string[];
}

export interface ProgressiveContentStressCase {
	readonly concurrency: number;
	readonly operations: number;
	readonly elapsedMs: number;
	readonly throughputPerSecond: number;
	readonly latencyMs: {
		readonly p50: number;
		readonly p95: number;
		readonly p99: number;
		readonly maximum: number;
	};
	readonly sourceWork: {
		readonly bytesRead: number;
		readonly readCalls: number;
		readonly rowsRead: number;
		readonly parentScans: number;
	};
	readonly failures: readonly string[];
}

export interface ProgressiveContentStressReport {
	readonly schemaVersion: typeof PROGRESSIVE_CONTENT_STRESS_SCHEMA_VERSION;
	readonly adapterId: string;
	readonly objectId: string;
	readonly status: "passed" | "failed";
	readonly cases: readonly ProgressiveContentStressCase[];
	readonly resources: {
		readonly before: ProgressiveContentResourceSample;
		readonly after: ProgressiveContentResourceSample;
		readonly rssGrowthBytes: number;
		readonly heapGrowthBytes: number;
		readonly externalGrowthBytes: number;
		readonly arrayBuffersGrowthBytes: number;
		readonly fileDescriptorGrowth?: number;
	};
}

export interface ProgressiveContentSoakReport {
	readonly schemaVersion: typeof PROGRESSIVE_CONTENT_STRESS_SCHEMA_VERSION;
	readonly adapterId: string;
	readonly objectId: string;
	readonly status: "passed" | "failed";
	readonly durationMs: number;
	readonly operations: number;
	readonly requiredDurationMs: number;
	readonly requiredOperations: number;
	readonly sampleEveryOperations: number;
	readonly warmupOperations: number;
	readonly positiveLeakControlDetected: boolean;
	readonly batches: number;
	readonly failures: readonly string[];
	readonly resourceSamples: readonly ProgressiveContentResourcePoint[];
	readonly resourceDrift: ProgressiveContentResourceDrift;
	readonly positiveLeakControlSamples: readonly ProgressiveContentResourceSample[];
	readonly positiveLeakControlDrift: ProgressiveContentResourceDrift;
	readonly stress: ProgressiveContentStressReport;
}

function defaultResourceSample(): ProgressiveContentResourceSample {
	const value = process.memoryUsage();
	return {
		rssBytes: value.rss,
		heapUsedBytes: value.heapUsed,
		externalBytes: value.external,
		arrayBuffersBytes: value.arrayBuffers,
	};
}

function percentile(sorted: readonly number[], ratio: number): number {
	if (sorted.length === 0) return 0;
	return (
		sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ??
		0
	);
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${label} must be a positive safe integer`);
	}
	return value;
}

function finiteNonNegativeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${label} must be a non-negative safe integer`);
	}
	return value;
}

function p95Metric(
	samples: readonly ProgressiveContentResourcePoint[],
	select: (sample: ProgressiveContentResourceSample) => number,
): number {
	return percentile(
		samples
			.map(({ sample }) => select(sample))
			.sort((left, right) => left - right),
		0.95,
	);
}

function optionalGrowth(
	samples: readonly ProgressiveContentResourcePoint[],
	select: (sample: ProgressiveContentResourceSample) => number | undefined,
): number | undefined {
	const values = samples
		.map(({ sample }) => select(sample))
		.filter((value): value is number => value !== undefined);
	if (values.length !== samples.length || values.length < 2) return undefined;
	return (values.at(-1) ?? 0) - (values[0] ?? 0);
}

/** Detect sustained post-warmup growth with the same oracle used by the leak control. */
export function analyzeProgressiveContentResourceDrift(input: {
	readonly samples: readonly ProgressiveContentResourcePoint[];
	readonly warmupOperations?: number;
	readonly minimumMemoryAllowanceBytes?: number;
	readonly maximumMemoryGrowthRatio?: number;
}): ProgressiveContentResourceDrift {
	const warmupOperations = finiteNonNegativeInteger(
		input.warmupOperations ?? 0,
		"warmupOperations",
	);
	const minimumMemoryAllowanceBytes = positiveInteger(
		input.minimumMemoryAllowanceBytes ?? 16 * 1024 * 1024,
		"minimumMemoryAllowanceBytes",
	);
	const maximumMemoryGrowthRatio = input.maximumMemoryGrowthRatio ?? 0.05;
	if (
		!Number.isFinite(maximumMemoryGrowthRatio) ||
		maximumMemoryGrowthRatio < 0
	) {
		throw new RangeError(
			"maximumMemoryGrowthRatio must be finite and non-negative",
		);
	}
	const samples = input.samples.filter(
		({ operation }) => operation >= warmupOperations,
	);
	if (samples.length < 2) {
		return {
			status: "failed",
			warmupOperations,
			memoryGrowthLimitsBytes: {
				rss: minimumMemoryAllowanceBytes,
				heap: minimumMemoryAllowanceBytes,
				external: minimumMemoryAllowanceBytes,
				arrayBuffers: minimumMemoryAllowanceBytes,
			},
			rssP95GrowthBytes: 0,
			heapP95GrowthBytes: 0,
			externalP95GrowthBytes: 0,
			arrayBuffersP95GrowthBytes: 0,
			failures: ["resource drift requires at least two post-warmup samples"],
		};
	}
	const split = Math.max(1, Math.floor(samples.length / 2));
	const early = samples.slice(0, split);
	const late = samples.slice(split);
	const baselineRss = p95Metric(early, ({ rssBytes }) => rssBytes);
	const baselineHeap = p95Metric(early, ({ heapUsedBytes }) => heapUsedBytes);
	const baselineExternal = p95Metric(
		early,
		({ externalBytes }) => externalBytes,
	);
	const baselineArrayBuffers = p95Metric(
		early,
		({ arrayBuffersBytes }) => arrayBuffersBytes,
	);
	const memoryGrowthLimitsBytes = {
		rss: Math.max(
			minimumMemoryAllowanceBytes,
			Math.ceil(baselineRss * maximumMemoryGrowthRatio),
		),
		heap: Math.max(
			minimumMemoryAllowanceBytes,
			Math.ceil(baselineHeap * maximumMemoryGrowthRatio),
		),
		external: Math.max(
			minimumMemoryAllowanceBytes,
			Math.ceil(baselineExternal * maximumMemoryGrowthRatio),
		),
		arrayBuffers: Math.max(
			minimumMemoryAllowanceBytes,
			Math.ceil(baselineArrayBuffers * maximumMemoryGrowthRatio),
		),
	};
	const rssP95GrowthBytes =
		p95Metric(late, ({ rssBytes }) => rssBytes) - baselineRss;
	const heapP95GrowthBytes =
		p95Metric(late, ({ heapUsedBytes }) => heapUsedBytes) - baselineHeap;
	const externalP95GrowthBytes =
		p95Metric(late, ({ externalBytes }) => externalBytes) - baselineExternal;
	const arrayBuffersP95GrowthBytes =
		p95Metric(late, ({ arrayBuffersBytes }) => arrayBuffersBytes) -
		baselineArrayBuffers;
	const fileDescriptorGrowth = optionalGrowth(
		samples,
		({ fileDescriptors }) => fileDescriptors,
	);
	const temporaryArtifactGrowth = optionalGrowth(
		samples,
		({ temporaryArtifacts }) => temporaryArtifacts,
	);
	const databaseRowGrowth = optionalGrowth(
		samples,
		({ databaseRows }) => databaseRows,
	);
	const walGrowthBytes = optionalGrowth(samples, ({ walBytes }) => walBytes);
	const failures: string[] = [];
	for (const [label, growth, limit] of [
		["rss", rssP95GrowthBytes, memoryGrowthLimitsBytes.rss],
		["heap", heapP95GrowthBytes, memoryGrowthLimitsBytes.heap],
		["external", externalP95GrowthBytes, memoryGrowthLimitsBytes.external],
		[
			"arrayBuffers",
			arrayBuffersP95GrowthBytes,
			memoryGrowthLimitsBytes.arrayBuffers,
		],
	] as const) {
		if (growth > limit) {
			failures.push(`${label} p95 growth ${growth} exceeds ${limit}`);
		}
	}
	for (const [label, growth] of [
		["file descriptors", fileDescriptorGrowth],
		["temporary artifacts", temporaryArtifactGrowth],
		["database rows", databaseRowGrowth],
	] as const) {
		if (growth !== undefined && growth > 0) {
			failures.push(`${label} grew by ${growth}`);
		}
	}
	return {
		status: failures.length === 0 ? "passed" : "failed",
		warmupOperations,
		memoryGrowthLimitsBytes,
		rssP95GrowthBytes,
		heapP95GrowthBytes,
		externalP95GrowthBytes,
		arrayBuffersP95GrowthBytes,
		...(fileDescriptorGrowth === undefined ? {} : { fileDescriptorGrowth }),
		...(temporaryArtifactGrowth === undefined
			? {}
			: { temporaryArtifactGrowth }),
		...(databaseRowGrowth === undefined ? {} : { databaseRowGrowth }),
		...(walGrowthBytes === undefined ? {} : { walGrowthBytes }),
		failures,
	};
}

/** Exercise deterministic pages at each required concurrency and record bounded work. */
export async function runProgressiveContentStress(input: {
	readonly adapter: ProgressiveContentConformanceAdapter;
	readonly object: ProgressiveConformanceObject;
	readonly concurrency?: readonly number[];
	readonly operationsPerWorker?: number;
	readonly pageBytes?: number;
	readonly measureResources?: () =>
		| ProgressiveContentResourceSample
		| Promise<ProgressiveContentResourceSample>;
}): Promise<ProgressiveContentStressReport> {
	const levels = input.concurrency ?? REQUIRED_PROGRESSIVE_CONTENT_CONCURRENCY;
	const operationsPerWorker = positiveInteger(
		input.operationsPerWorker ?? 4,
		"operationsPerWorker",
	);
	const pageBytes = positiveInteger(input.pageBytes ?? 64 * 1024, "pageBytes");
	if (levels.length === 0)
		throw new RangeError("concurrency must not be empty");
	for (const level of levels) positiveInteger(level, "concurrency level");
	const measure = input.measureResources ?? defaultResourceSample;
	const before = await measure();
	const cases: ProgressiveContentStressCase[] = [];
	const pageCount = Math.max(1, Math.ceil(input.object.byteLength / pageBytes));

	for (const concurrency of levels) {
		const latencies: number[] = [];
		const failures: string[] = [];
		let bytesRead = 0;
		let readCalls = 0;
		let rowsRead = 0;
		let parentScans = 0;
		const startedAt = performance.now();
		await Promise.all(
			Array.from({ length: concurrency }, async (_, worker) => {
				for (
					let operation = 0;
					operation < operationsPerWorker;
					operation += 1
				) {
					const pageIndex = (worker + operation) % pageCount;
					const offset = pageIndex * pageBytes;
					const pageStartedAt = performance.now();
					try {
						const page = await input.adapter.read({
							objectId: input.object.id,
							authorizationScope: input.object.authorizationScope,
							offset,
							limit: pageBytes,
							expectedRevision: input.object.revision,
						});
						latencies.push(performance.now() - pageStartedAt);
						bytesRead += page.sourceWork.bytesRead;
						readCalls += page.sourceWork.readCalls;
						rowsRead += page.sourceWork.rowsRead;
						parentScans += page.sourceWork.parentScans;
						const end = offset + page.bytes.byteLength;
						if (
							page.view.reference.revision !== input.object.revision ||
							page.view.slice.range.start !== offset ||
							page.view.slice.range.end !== end ||
							page.view.slice.sliceSha256 !==
								createHash("sha256").update(page.bytes).digest("hex") ||
							page.sourceWork.parentScans !== 0 ||
							page.sourceWork.bytesRead > page.bytes.byteLength * 2 + pageBytes
						) {
							failures.push(
								`worker ${worker} operation ${operation} violated paging invariants`,
							);
						}
					} catch (error) {
						failures.push(
							`worker ${worker} operation ${operation}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
				}
			}),
		);
		const elapsedMs = performance.now() - startedAt;
		latencies.sort((left, right) => left - right);
		const operations = concurrency * operationsPerWorker;
		cases.push({
			concurrency,
			operations,
			elapsedMs,
			throughputPerSecond:
				elapsedMs === 0 ? operations : (operations * 1_000) / elapsedMs,
			latencyMs: {
				p50: percentile(latencies, 0.5),
				p95: percentile(latencies, 0.95),
				p99: percentile(latencies, 0.99),
				maximum: latencies.at(-1) ?? 0,
			},
			sourceWork: { bytesRead, readCalls, rowsRead, parentScans },
			failures,
		});
	}
	const after = await measure();
	const fileDescriptorGrowth =
		before.fileDescriptors === undefined || after.fileDescriptors === undefined
			? undefined
			: after.fileDescriptors - before.fileDescriptors;
	return {
		schemaVersion: PROGRESSIVE_CONTENT_STRESS_SCHEMA_VERSION,
		adapterId: input.adapter.adapterId,
		objectId: input.object.id,
		status: cases.every(({ failures }) => failures.length === 0)
			? "passed"
			: "failed",
		cases,
		resources: {
			before,
			after,
			rssGrowthBytes: after.rssBytes - before.rssBytes,
			heapGrowthBytes: after.heapUsedBytes - before.heapUsedBytes,
			externalGrowthBytes: after.externalBytes - before.externalBytes,
			arrayBuffersGrowthBytes:
				after.arrayBuffersBytes - before.arrayBuffersBytes,
			...(fileDescriptorGrowth === undefined ? {} : { fileDescriptorGrowth }),
		},
	};
}

/** Run the same stress contract until both the duration and operation targets are met. */
export async function runProgressiveContentSoak(input: {
	readonly adapter: ProgressiveContentConformanceAdapter;
	readonly object: ProgressiveConformanceObject;
	readonly requiredDurationMs?: number;
	readonly requiredOperations?: number;
	readonly batchOperationsPerWorker?: number;
	readonly concurrency?: number;
	readonly sampleEveryOperations?: number;
	readonly warmupOperations?: number;
	readonly positiveLeakControl: () =>
		| readonly ProgressiveContentResourceSample[]
		| Promise<readonly ProgressiveContentResourceSample[]>;
	readonly measureResources?: () =>
		| ProgressiveContentResourceSample
		| Promise<ProgressiveContentResourceSample>;
}): Promise<ProgressiveContentSoakReport> {
	const requiredDurationMs = positiveInteger(
		input.requiredDurationMs ?? REQUIRED_PROGRESSIVE_CONTENT_SOAK_DURATION_MS,
		"requiredDurationMs",
	);
	const requiredOperations = positiveInteger(
		input.requiredOperations ?? REQUIRED_PROGRESSIVE_CONTENT_SOAK_OPERATIONS,
		"requiredOperations",
	);
	const concurrency = positiveInteger(input.concurrency ?? 8, "concurrency");
	const batchOperationsPerWorker = positiveInteger(
		input.batchOperationsPerWorker ?? 16,
		"batchOperationsPerWorker",
	);
	const sampleEveryOperations = positiveInteger(
		input.sampleEveryOperations ?? 1_000,
		"sampleEveryOperations",
	);
	const warmupOperations = finiteNonNegativeInteger(
		input.warmupOperations ??
			Math.min(10_000, Math.floor(requiredOperations / 10)),
		"warmupOperations",
	);
	const startedAt = performance.now();
	let operations = 0;
	let batches = 0;
	let lastSampledOperation = -1;
	let latest: ProgressiveContentStressReport | undefined;
	const failures: string[] = [];
	const resourceSamples: ProgressiveContentResourcePoint[] = [];
	do {
		latest = await runProgressiveContentStress({
			adapter: input.adapter,
			object: input.object,
			concurrency: [concurrency],
			operationsPerWorker: batchOperationsPerWorker,
			measureResources: input.measureResources,
		});
		operations += concurrency * batchOperationsPerWorker;
		batches += 1;
		for (const stressCase of latest.cases)
			failures.push(...stressCase.failures);
		if (resourceSamples.length === 0) {
			resourceSamples.push({
				operation: Math.max(
					0,
					operations - concurrency * batchOperationsPerWorker,
				),
				elapsedMs: 0,
				sample: latest.resources.before,
			});
			lastSampledOperation = resourceSamples[0]?.operation ?? 0;
		}
		if (operations - lastSampledOperation >= sampleEveryOperations) {
			resourceSamples.push({
				operation: operations,
				elapsedMs: performance.now() - startedAt,
				sample: latest.resources.after,
			});
			lastSampledOperation = operations;
		}
	} while (
		operations < requiredOperations ||
		performance.now() - startedAt < requiredDurationMs
	);
	const durationMs = performance.now() - startedAt;
	if (lastSampledOperation !== operations && latest) {
		resourceSamples.push({
			operation: operations,
			elapsedMs: durationMs,
			sample: latest.resources.after,
		});
	}
	const resourceDrift = analyzeProgressiveContentResourceDrift({
		samples: resourceSamples,
		warmupOperations,
	});
	const leakSamples = await input.positiveLeakControl();
	const positiveLeakControlDrift = analyzeProgressiveContentResourceDrift({
		samples: leakSamples.map((sample, index) => ({
			operation: index,
			elapsedMs: index,
			sample,
		})),
	});
	const positiveLeakControlDetected =
		positiveLeakControlDrift.status === "failed";
	if (!positiveLeakControlDetected) {
		failures.push("positive leak control was not detected");
	}
	if (resourceDrift.status === "failed")
		failures.push(...resourceDrift.failures);
	return {
		schemaVersion: PROGRESSIVE_CONTENT_STRESS_SCHEMA_VERSION,
		adapterId: input.adapter.adapterId,
		objectId: input.object.id,
		status:
			failures.length === 0 &&
			latest.status === "passed" &&
			positiveLeakControlDetected
				? "passed"
				: "failed",
		durationMs,
		operations,
		requiredDurationMs,
		requiredOperations,
		sampleEveryOperations,
		warmupOperations,
		positiveLeakControlDetected,
		batches,
		failures,
		resourceSamples,
		resourceDrift,
		positiveLeakControlSamples: leakSamples,
		positiveLeakControlDrift,
		stress: latest,
	};
}
