/** Measures progressive-content traversal with explicit cold/warm phases and process-level resource samples. */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
	PROGRESSIVE_CONTENT_TARGET_FAMILIES,
	type ProgressiveContentTarget,
	type ProgressiveContentTargetFamily,
} from "./progressive-content-target";

export const PROGRESSIVE_CONTENT_BENCHMARK_SCHEMA_VERSION =
	"elizaos.progressive-content.benchmark.v2" as const;
export const PROGRESSIVE_CONTENT_BENCHMARK_SOURCE_BYTES = [
	1 * 1024 * 1024,
	10 * 1024 * 1024,
	100 * 1024 * 1024,
] as const;
export const PROGRESSIVE_CONTENT_BENCHMARK_REPETITIONS = 5;
export const PROGRESSIVE_CONTENT_BENCHMARK_PAGE_BYTES = 64 * 1024;

export interface ProgressiveContentBenchmarkResourceSample {
	readonly rssBytes: number;
	readonly heapUsedBytes: number;
	readonly externalBytes: number;
	readonly arrayBuffersBytes: number;
	readonly fileDescriptors: number;
	readonly databaseBytes: number;
	readonly databaseRows: number;
	readonly walBytes: number;
}

export interface ProgressiveContentBenchmarkDistribution {
	readonly p50: number;
	readonly p95: number;
	readonly p99: number;
	readonly maximum: number;
}

export interface ProgressiveContentBenchmarkPhaseSample {
	readonly phase: "cold" | "warm";
	readonly elapsedMs: number;
	readonly instrumentationMs: number;
	readonly throughputBytesPerSecond: number;
	readonly pageLatencySamplesMs: readonly number[];
	readonly pageLatencyMs: ProgressiveContentBenchmarkDistribution;
	readonly pages: number;
	readonly bytesReturned: number;
	readonly sourceWork: {
		readonly bytesRead: number;
		readonly readCalls: number;
		readonly rowsRead: number;
		readonly parentScans: number;
	};
	readonly resourceGrowth: ProgressiveContentBenchmarkResourceSample;
}

export interface ProgressiveContentBenchmarkProcessSample {
	readonly family: ProgressiveContentTargetFamily;
	readonly adapterId: string;
	readonly productionMethod: string;
	readonly sourceBytes: number;
	readonly repetition: number;
	readonly processId: number;
	readonly freshProcess: boolean;
	readonly setupGrowth: ProgressiveContentBenchmarkResourceSample;
	readonly cold: ProgressiveContentBenchmarkPhaseSample;
	readonly warm: ProgressiveContentBenchmarkPhaseSample;
}

export interface ProgressiveContentBenchmarkReport {
	readonly schemaVersion: typeof PROGRESSIVE_CONTENT_BENCHMARK_SCHEMA_VERSION;
	readonly status: "passed" | "failed";
	readonly evidenceEligible: boolean;
	readonly families: readonly ProgressiveContentTargetFamily[];
	readonly sourceSizes: readonly number[];
	readonly repetitions: number;
	readonly processCount: number;
	readonly cases: readonly {
		readonly family: ProgressiveContentTargetFamily;
		readonly adapterId: string;
		readonly productionMethod: string;
		readonly sourceBytes: number;
		readonly repetitions: number;
		readonly setupGrowth: ProgressiveContentBenchmarkAggregate["resourceGrowth"];
		readonly cold: ProgressiveContentBenchmarkAggregate;
		readonly warm: ProgressiveContentBenchmarkAggregate;
	}[];
	readonly samples: readonly ProgressiveContentBenchmarkProcessSample[];
	readonly failures: readonly string[];
}

export interface ProgressiveContentBenchmarkAggregate {
	readonly pageLatencyMs: ProgressiveContentBenchmarkDistribution;
	readonly throughputBytesPerSecond: ProgressiveContentBenchmarkDistribution;
	readonly elapsedMs: ProgressiveContentBenchmarkDistribution;
	readonly resourceGrowth: {
		readonly [K in keyof ProgressiveContentBenchmarkResourceSample]: ProgressiveContentBenchmarkDistribution;
	};
}

const RESOURCE_FIELDS = [
	"rssBytes",
	"heapUsedBytes",
	"externalBytes",
	"arrayBuffersBytes",
	"fileDescriptors",
	"databaseBytes",
	"databaseRows",
	"walBytes",
] as const;

function positiveSafeInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new RangeError(`${label} must be a positive safe integer`);
	return value;
}

function validateResourceSample(
	value: ProgressiveContentBenchmarkResourceSample,
): ProgressiveContentBenchmarkResourceSample {
	for (const field of RESOURCE_FIELDS) {
		if (!Number.isSafeInteger(value[field]) || value[field] < 0)
			throw new TypeError(`${field} must be a non-negative safe integer`);
	}
	return value;
}

function percentile(sorted: readonly number[], ratio: number): number {
	if (sorted.length === 0) return 0;
	return (
		sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)] ??
		0
	);
}

/** Produce p50/p95/p99/maximum without interpolating measurements that were never observed. */
export function progressiveContentBenchmarkDistribution(
	values: readonly number[],
): ProgressiveContentBenchmarkDistribution {
	if (values.some((value) => !Number.isFinite(value) || value < 0))
		throw new TypeError(
			"benchmark distributions require finite non-negative values",
		);
	const sorted = [...values].sort((left, right) => left - right);
	return {
		p50: percentile(sorted, 0.5),
		p95: percentile(sorted, 0.95),
		p99: percentile(sorted, 0.99),
		maximum: sorted.at(-1) ?? 0,
	};
}

function growth(
	baseline: ProgressiveContentBenchmarkResourceSample,
	peak: ProgressiveContentBenchmarkResourceSample,
): ProgressiveContentBenchmarkResourceSample {
	return Object.fromEntries(
		RESOURCE_FIELDS.map((field) => [
			field,
			Math.max(0, peak[field] - baseline[field]),
		]),
	) as unknown as ProgressiveContentBenchmarkResourceSample;
}

function maxResources(
	left: ProgressiveContentBenchmarkResourceSample,
	right: ProgressiveContentBenchmarkResourceSample,
): ProgressiveContentBenchmarkResourceSample {
	return Object.fromEntries(
		RESOURCE_FIELDS.map((field) => [
			field,
			Math.max(left[field], right[field]),
		]),
	) as unknown as ProgressiveContentBenchmarkResourceSample;
}

async function traversePhase(input: {
	target: ProgressiveContentTarget;
	phase: "cold" | "warm";
	pageBytes: number;
	measureResources: () => Promise<ProgressiveContentBenchmarkResourceSample>;
}): Promise<ProgressiveContentBenchmarkPhaseSample> {
	const baseline = validateResourceSample(await input.measureResources());
	let peak = baseline;
	let offset = 0;
	let pages = 0;
	let bytesRead = 0;
	let readCalls = 0;
	let rowsRead = 0;
	let parentScans = 0;
	const latencies: number[] = [];
	const digest = createHash("sha256");
	const startedAt = performance.now();
	let instrumentationMs = 0;
	while (offset < input.target.object.byteLength) {
		const pageStartedAt = performance.now();
		const page = await input.target.read({
			access: "authorized",
			offset,
			limit: input.pageBytes,
			expectedRevision: input.target.object.revision,
		});
		latencies.push(performance.now() - pageStartedAt);
		if (page.bytes.byteLength === 0)
			throw new Error(`${input.phase} traversal made no progress at ${offset}`);
		const end = offset + page.bytes.byteLength;
		if (
			page.view.slice.range.start !== offset ||
			page.view.slice.range.end !== end ||
			page.view.slice.sliceSha256 !==
				createHash("sha256").update(page.bytes).digest("hex")
		)
			throw new Error(
				`${input.phase} traversal returned an invalid page at ${offset}`,
			);
		digest.update(page.bytes);
		pages += 1;
		bytesRead += page.sourceWork.bytesRead;
		readCalls += page.sourceWork.readCalls;
		rowsRead += page.sourceWork.rowsRead;
		parentScans += page.sourceWork.parentScans;
		offset = end;
		const instrumentationStartedAt = performance.now();
		peak = maxResources(
			peak,
			validateResourceSample(await input.measureResources()),
		);
		instrumentationMs += performance.now() - instrumentationStartedAt;
	}
	const elapsedMs = Math.max(
		0,
		performance.now() - startedAt - instrumentationMs,
	);
	if (digest.digest("hex") !== input.target.object.sourceSha256)
		throw new Error(`${input.phase} traversal SHA-256 differs from the source`);
	return {
		phase: input.phase,
		elapsedMs,
		instrumentationMs,
		throughputBytesPerSecond:
			elapsedMs === 0 ? offset : (offset * 1_000) / elapsedMs,
		pageLatencySamplesMs: latencies,
		pageLatencyMs: progressiveContentBenchmarkDistribution(latencies),
		pages,
		bytesReturned: offset,
		sourceWork: { bytesRead, readCalls, rowsRead, parentScans },
		resourceGrowth: growth(baseline, peak),
	};
}

/** Run one process sample: target creation, a cold traversal, then a warm traversal. */
export async function runProgressiveContentBenchmarkProcessSample(input: {
	readonly family: ProgressiveContentTargetFamily;
	readonly adapterId: string;
	readonly productionMethod: string;
	readonly sourceBytes: number;
	readonly repetition: number;
	readonly processId?: number;
	readonly freshProcess: boolean;
	readonly createTarget: () => Promise<ProgressiveContentTarget>;
	readonly measureResources: (
		target?: ProgressiveContentTarget,
	) =>
		| ProgressiveContentBenchmarkResourceSample
		| Promise<ProgressiveContentBenchmarkResourceSample>;
	readonly pageBytes?: number;
}): Promise<ProgressiveContentBenchmarkProcessSample> {
	if (!PROGRESSIVE_CONTENT_TARGET_FAMILIES.includes(input.family))
		throw new TypeError("benchmark family is unsupported");
	if (!input.adapterId || !input.productionMethod)
		throw new TypeError("benchmark native adapter identity is required");
	positiveSafeInteger(input.sourceBytes, "sourceBytes");
	positiveSafeInteger(input.repetition, "repetition");
	const pageBytes = positiveSafeInteger(
		input.pageBytes ?? PROGRESSIVE_CONTENT_BENCHMARK_PAGE_BYTES,
		"pageBytes",
	);
	const beforeSetup = validateResourceSample(await input.measureResources());
	const target = await input.createTarget();
	if (target.object.byteLength !== input.sourceBytes)
		throw new TypeError(
			"benchmark target size differs from the requested source size",
		);
	try {
		const afterSetup = validateResourceSample(
			await input.measureResources(target),
		);
		await target.restart();
		const measure = async () =>
			validateResourceSample(await input.measureResources(target));
		const cold = await traversePhase({
			target,
			phase: "cold",
			pageBytes,
			measureResources: measure,
		});
		const warm = await traversePhase({
			target,
			phase: "warm",
			pageBytes,
			measureResources: measure,
		});
		return {
			family: input.family,
			adapterId: input.adapterId,
			productionMethod: input.productionMethod,
			sourceBytes: input.sourceBytes,
			repetition: input.repetition,
			processId: input.processId ?? process.pid,
			freshProcess: input.freshProcess,
			setupGrowth: growth(beforeSetup, afterSetup),
			cold,
			warm,
		};
	} finally {
		await target.cleanup();
	}
}

function aggregatePhase(
	samples: readonly ProgressiveContentBenchmarkPhaseSample[],
): ProgressiveContentBenchmarkAggregate {
	const resourceGrowth = Object.fromEntries(
		RESOURCE_FIELDS.map((field) => [
			field,
			progressiveContentBenchmarkDistribution(
				samples.map((sample) => sample.resourceGrowth[field]),
			),
		]),
	) as ProgressiveContentBenchmarkAggregate["resourceGrowth"];
	return {
		pageLatencyMs: progressiveContentBenchmarkDistribution(
			samples.flatMap((sample) => sample.pageLatencySamplesMs),
		),
		throughputBytesPerSecond: progressiveContentBenchmarkDistribution(
			samples.map(({ throughputBytesPerSecond }) => throughputBytesPerSecond),
		),
		elapsedMs: progressiveContentBenchmarkDistribution(
			samples.map(({ elapsedMs }) => elapsedMs),
		),
		resourceGrowth,
	};
}

/** Validate and aggregate the exact 1/10/100 MiB by five-repetition process matrix. */
export function buildProgressiveContentBenchmarkReport(input: {
	readonly samples: readonly ProgressiveContentBenchmarkProcessSample[];
	readonly families?: readonly ProgressiveContentTargetFamily[];
	readonly sourceSizes?: readonly number[];
	readonly repetitions?: number;
}): ProgressiveContentBenchmarkReport {
	const families = input.families ?? PROGRESSIVE_CONTENT_TARGET_FAMILIES;
	const sourceSizes =
		input.sourceSizes ?? PROGRESSIVE_CONTENT_BENCHMARK_SOURCE_BYTES;
	const repetitions = positiveSafeInteger(
		input.repetitions ?? PROGRESSIVE_CONTENT_BENCHMARK_REPETITIONS,
		"repetitions",
	);
	const failures: string[] = [];
	const expected = new Set<string>();
	if (
		new Set(families).size !== families.length ||
		families.some(
			(family) => !PROGRESSIVE_CONTENT_TARGET_FAMILIES.includes(family),
		)
	)
		throw new TypeError("benchmark families must be unique and supported");
	for (const family of families) {
		for (const sourceBytes of sourceSizes) {
			positiveSafeInteger(sourceBytes, "source size");
			for (let repetition = 1; repetition <= repetitions; repetition += 1)
				expected.add(`${family}:${sourceBytes}:${repetition}`);
		}
	}
	const identities = new Set<string>();
	const processIds = new Set<number>();
	for (const sample of input.samples) {
		const identity = `${sample.family}:${sample.sourceBytes}:${sample.repetition}`;
		if (
			!Number.isSafeInteger(sample.processId) ||
			sample.processId <= 0 ||
			!sample.adapterId ||
			!sample.productionMethod
		)
			failures.push(`sample ${identity} lacks native process identity`);
		if (!expected.has(identity)) failures.push(`unexpected sample ${identity}`);
		if (identities.has(identity)) failures.push(`duplicate sample ${identity}`);
		identities.add(identity);
		if (!sample.freshProcess)
			failures.push(`sample ${identity} was not process-isolated`);
		if (processIds.has(sample.processId))
			failures.push(`process ${sample.processId} was reused`);
		processIds.add(sample.processId);
		for (const phase of [sample.cold, sample.warm]) {
			if (
				phase.bytesReturned !== sample.sourceBytes ||
				phase.pages <= 0 ||
				phase.sourceWork.parentScans !== 0 ||
				phase.sourceWork.bytesRead >
					phase.bytesReturned * 2 + PROGRESSIVE_CONTENT_BENCHMARK_PAGE_BYTES
			)
				failures.push(
					`sample ${identity} ${phase.phase} traversal is incomplete or unbounded`,
				);
		}
	}
	for (const identity of expected)
		if (!identities.has(identity)) failures.push(`missing sample ${identity}`);
	const cases = families.flatMap((family) =>
		sourceSizes.map((sourceBytes) => {
			const samples = input.samples
				.filter(
					(sample) =>
						sample.family === family && sample.sourceBytes === sourceBytes,
				)
				.sort((left, right) => left.repetition - right.repetition);
			const adapterIds = new Set(samples.map(({ adapterId }) => adapterId));
			const productionMethods = new Set(
				samples.map(({ productionMethod }) => productionMethod),
			);
			if (
				samples.length > 0 &&
				(adapterIds.size !== 1 || productionMethods.size !== 1)
			)
				failures.push(
					`${family}:${sourceBytes} changed native adapter identity across repetitions`,
				);
			return {
				family,
				adapterId: samples[0]?.adapterId ?? "missing",
				productionMethod: samples[0]?.productionMethod ?? "missing",
				sourceBytes,
				repetitions: samples.length,
				setupGrowth: Object.fromEntries(
					RESOURCE_FIELDS.map((field) => [
						field,
						progressiveContentBenchmarkDistribution(
							samples.map((sample) => sample.setupGrowth[field]),
						),
					]),
				) as ProgressiveContentBenchmarkAggregate["resourceGrowth"],
				cold: aggregatePhase(samples.map(({ cold }) => cold)),
				warm: aggregatePhase(samples.map(({ warm }) => warm)),
			};
		}),
	);
	const exactProductionPolicy =
		families.length === PROGRESSIVE_CONTENT_TARGET_FAMILIES.length &&
		families.every(
			(value, index) => value === PROGRESSIVE_CONTENT_TARGET_FAMILIES[index],
		) &&
		sourceSizes.length === PROGRESSIVE_CONTENT_BENCHMARK_SOURCE_BYTES.length &&
		sourceSizes.every(
			(value, index) =>
				value === PROGRESSIVE_CONTENT_BENCHMARK_SOURCE_BYTES[index],
		) &&
		repetitions === PROGRESSIVE_CONTENT_BENCHMARK_REPETITIONS;
	return {
		schemaVersion: PROGRESSIVE_CONTENT_BENCHMARK_SCHEMA_VERSION,
		status: failures.length === 0 ? "passed" : "failed",
		evidenceEligible: failures.length === 0 && exactProductionPolicy,
		families: [...families],
		sourceSizes: [...sourceSizes],
		repetitions,
		processCount: processIds.size,
		cases,
		samples: input.samples,
		failures,
	};
}
