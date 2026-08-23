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
	readonly positiveLeakControlDetected: boolean;
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
	readonly positiveLeakControl: () => boolean | Promise<boolean>;
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
	const startedAt = performance.now();
	let operations = 0;
	let latest: ProgressiveContentStressReport | undefined;
	do {
		latest = await runProgressiveContentStress({
			adapter: input.adapter,
			object: input.object,
			concurrency: [concurrency],
			operationsPerWorker: batchOperationsPerWorker,
			measureResources: input.measureResources,
		});
		operations += concurrency * batchOperationsPerWorker;
	} while (
		operations < requiredOperations ||
		performance.now() - startedAt < requiredDurationMs
	);
	const durationMs = performance.now() - startedAt;
	const positiveLeakControlDetected = await input.positiveLeakControl();
	return {
		schemaVersion: PROGRESSIVE_CONTENT_STRESS_SCHEMA_VERSION,
		adapterId: input.adapter.adapterId,
		objectId: input.object.id,
		status:
			latest.status === "passed" && positiveLeakControlDetected
				? "passed"
				: "failed",
		durationMs,
		operations,
		requiredDurationMs,
		requiredOperations,
		positiveLeakControlDetected,
		stress: latest,
	};
}
