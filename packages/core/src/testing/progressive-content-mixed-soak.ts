/** Runs the production-eligible six-family progressive-content soak contract. */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
	ProgressiveConformanceObject,
	ProgressiveContentConformanceAdapter,
} from "./progressive-content-conformance";
import {
	analyzeProgressiveContentResourceDrift,
	type ProgressiveContentResourceDrift,
	type ProgressiveContentResourcePoint,
	type ProgressiveContentResourceSample,
	REQUIRED_PROGRESSIVE_CONTENT_SOAK_DURATION_MS,
	REQUIRED_PROGRESSIVE_CONTENT_SOAK_OPERATIONS,
} from "./progressive-content-stress";

export const PROGRESSIVE_CONTENT_MIXED_SOAK_SCHEMA_VERSION =
	"elizaos.progressive-content.mixed-soak.v1" as const;
export const PROGRESSIVE_CONTENT_SOAK_FAMILIES = [
	"file",
	"document",
	"memory",
	"email",
	"attachment",
	"tool-output",
] as const;
export const PROGRESSIVE_CONTENT_SOAK_SAMPLE_EVERY_OPERATIONS = 1_000;

export type ProgressiveContentSoakFamily =
	(typeof PROGRESSIVE_CONTENT_SOAK_FAMILIES)[number];

export interface ProgressiveContentSoakTarget {
	readonly family: ProgressiveContentSoakFamily;
	readonly authoritativeStore:
		| "filesystem"
		| "content-addressed-media"
		| "document-store"
		| "message-store"
		| "memory-store";
	readonly productionMethod: string;
	readonly binaryPolicy: "native-bytes" | "typed-rejection";
	readonly create: () =>
		| {
				readonly adapter: ProgressiveContentConformanceAdapter;
				readonly object: ProgressiveConformanceObject;
		  }
		| Promise<{
				readonly adapter: ProgressiveContentConformanceAdapter;
				readonly object: ProgressiveConformanceObject;
		  }>;
}

export interface ProgressiveContentMixedResourceSample
	extends ProgressiveContentResourceSample {
	readonly fileDescriptors: number;
	readonly temporaryArtifacts: number;
	readonly databaseRows: number;
	readonly walBytes: number;
}

export interface ProgressiveContentMixedSoakFamilyReport {
	readonly family: ProgressiveContentSoakFamily;
	readonly adapterId: string;
	readonly objectId: string;
	readonly authoritativeStore: ProgressiveContentSoakTarget["authoritativeStore"];
	readonly productionMethod: string;
	readonly binaryPolicy: ProgressiveContentSoakTarget["binaryPolicy"];
	readonly operations: number;
	readonly failures: readonly string[];
	readonly sourceWork: {
		readonly bytesRead: number;
		readonly readCalls: number;
		readonly rowsRead: number;
		readonly parentScans: number;
	};
}

export interface ProgressiveContentMixedSoakReport {
	readonly schemaVersion: typeof PROGRESSIVE_CONTENT_MIXED_SOAK_SCHEMA_VERSION;
	readonly commit: string;
	readonly corpusManifestSha256: string;
	readonly clockSource: "system-monotonic" | "injected-contract-test";
	readonly evidenceEligible: boolean;
	readonly status: "passed" | "failed";
	readonly durationMs: number;
	readonly operations: number;
	readonly requiredDurationMs: number;
	readonly requiredOperations: number;
	readonly sampleEveryOperations: number;
	readonly warmupOperations: number;
	readonly batches: number;
	readonly failures: readonly string[];
	readonly families: readonly ProgressiveContentMixedSoakFamilyReport[];
	readonly resourceSamples: readonly ProgressiveContentResourcePoint[];
	readonly resourceDrift: ProgressiveContentResourceDrift;
	readonly positiveLeakControlDetected: boolean;
	readonly positiveLeakControlKind: "retained-array-buffer";
	readonly positiveLeakControlSamples: readonly ProgressiveContentResourceSample[];
	readonly positiveLeakControlDrift: ProgressiveContentResourceDrift;
}

interface MixedSoakExecutionPolicy {
	readonly requiredDurationMs: number;
	readonly requiredOperations: number;
	readonly batchOperations: number;
	readonly now: () => number;
	readonly waitUntil?: (targetElapsedMs: number) => Promise<void>;
	readonly clockSource: "system-monotonic" | "injected-contract-test";
}

function positiveInteger(value: number, label: string): number {
	if (!Number.isSafeInteger(value) || value <= 0)
		throw new RangeError(`${label} must be a positive safe integer`);
	return value;
}

function sha256(value: string, label: string): string {
	if (!/^[0-9a-f]{64}$/u.test(value))
		throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
	return value;
}

function validateResourceSample(
	sample: ProgressiveContentMixedResourceSample,
): ProgressiveContentMixedResourceSample {
	for (const field of [
		"rssBytes",
		"heapUsedBytes",
		"externalBytes",
		"arrayBuffersBytes",
		"fileDescriptors",
		"temporaryArtifacts",
		"databaseRows",
		"walBytes",
	] as const) {
		if (!Number.isSafeInteger(sample[field]) || sample[field] < 0)
			throw new TypeError(
				`resource sample ${field} must be a non-negative integer`,
			);
	}
	return sample;
}

function validateTargets(
	targets: readonly ProgressiveContentSoakTarget[],
): void {
	if (targets.length !== PROGRESSIVE_CONTENT_SOAK_FAMILIES.length)
		throw new TypeError("mixed soak requires exactly six family targets");
	const families = new Set(targets.map(({ family }) => family));
	if (
		families.size !== targets.length ||
		PROGRESSIVE_CONTENT_SOAK_FAMILIES.some((family) => !families.has(family))
	)
		throw new TypeError(
			"mixed soak targets must cover each required family once",
		);
	const expected = {
		file: ["filesystem", "native-bytes"],
		document: ["document-store", "typed-rejection"],
		memory: ["memory-store", "typed-rejection"],
		email: ["message-store", "typed-rejection"],
		attachment: ["content-addressed-media", "native-bytes"],
		"tool-output": ["filesystem", "native-bytes"],
	} as const;
	for (const target of targets) {
		const mapping = expected[target.family];
		if (
			target.authoritativeStore !== mapping[0] ||
			target.binaryPolicy !== mapping[1] ||
			typeof target.productionMethod !== "string" ||
			target.productionMethod.trim().length === 0 ||
			/(?:fixture|mock|stub|test)/iu.test(target.productionMethod)
		)
			throw new TypeError(
				`${target.family} target does not declare its required native production realization`,
			);
	}
}

async function runRealPositiveLeakControl(
	measure: () =>
		| ProgressiveContentMixedResourceSample
		| Promise<ProgressiveContentMixedResourceSample>,
): Promise<readonly ProgressiveContentResourceSample[]> {
	const before = await measure();
	const retained = new Uint8Array(32 * 1024 * 1024);
	for (let offset = 0; offset < retained.byteLength; offset += 4_096)
		retained[offset] = 1;
	// Let asynchronous resource samplers observe the allocation, but never rewrite
	// their measurements: production evidence must prove that the detector saw it.
	await new Promise<void>((resolve) => setImmediate(resolve));
	const after = await measure();
	void retained[0];
	return [before, after];
}

/** Internal deterministic seam; its reports are never production-evidence eligible. */
export async function runProgressiveContentMixedSoakContract(input: {
	readonly commit: string;
	readonly corpusManifestSha256: string;
	readonly targets: readonly ProgressiveContentSoakTarget[];
	readonly measureResources: () =>
		| ProgressiveContentMixedResourceSample
		| Promise<ProgressiveContentMixedResourceSample>;
	readonly policy: MixedSoakExecutionPolicy;
}): Promise<ProgressiveContentMixedSoakReport> {
	validateTargets(input.targets);
	sha256(input.corpusManifestSha256, "corpusManifestSha256");
	if (!/^[0-9a-f]{40}$/u.test(input.commit))
		throw new TypeError("commit must be a full lowercase Git SHA");
	const requiredDurationMs = positiveInteger(
		input.policy.requiredDurationMs,
		"requiredDurationMs",
	);
	const requiredOperations = positiveInteger(
		input.policy.requiredOperations,
		"requiredOperations",
	);
	const batchOperations = Math.min(
		PROGRESSIVE_CONTENT_SOAK_SAMPLE_EVERY_OPERATIONS,
		positiveInteger(input.policy.batchOperations, "batchOperations"),
	);
	const realized = await Promise.all(
		input.targets.map(async (target) => ({
			...target,
			...(await target.create()),
		})),
	);
	if (
		new Set(realized.map(({ adapter }) => adapter.adapterId)).size !==
			realized.length ||
		new Set(realized.map(({ object }) => object.id)).size !== realized.length
	)
		throw new TypeError(
			"mixed soak requires unique adapter and object identities",
		);
	const measureResources = async () =>
		validateResourceSample(await input.measureResources());
	for (const target of realized) {
		const expectedKind =
			target.family === "tool-output" ? "tool-result" : target.family;
		if (target.object.family !== expectedKind)
			throw new TypeError(`${target.family} target object kind is mismatched`);
	}
	const familyState = realized.map((target) => ({
		...target,
		operations: 0,
		failures: [] as string[],
		bytesRead: 0,
		readCalls: 0,
		rowsRead: 0,
		parentScans: 0,
	}));
	const resourceSamples: ProgressiveContentResourcePoint[] = [
		{ operation: 0, elapsedMs: 0, sample: await measureResources() },
	];
	const startedAt = input.policy.now();
	let operations = 0;
	let batches = 0;
	do {
		const count = Math.min(
			batchOperations,
			Math.max(1, requiredOperations - operations),
		);
		await Promise.all(
			Array.from({ length: count }, async (_, index) => {
				const sequence = operations + index;
				const target = familyState[sequence % familyState.length];
				if (!target) return;
				const pageBytes = 64 * 1024;
				const expectedKind =
					target.family === "tool-output" ? "tool-result" : target.family;
				const pages = Math.max(
					1,
					Math.ceil(target.object.byteLength / pageBytes),
				);
				const offset = (target.operations % pages) * pageBytes;
				target.operations += 1;
				try {
					const page = await target.adapter.read({
						objectId: target.object.id,
						authorizationScope: target.object.authorizationScope,
						offset,
						limit: pageBytes,
						expectedRevision: target.object.revision,
					});
					target.bytesRead += page.sourceWork.bytesRead;
					target.readCalls += page.sourceWork.readCalls;
					target.rowsRead += page.sourceWork.rowsRead;
					target.parentScans += page.sourceWork.parentScans;
					const end = offset + page.bytes.byteLength;
					if (
						page.view.reference.kind !== expectedKind ||
						page.view.slice.range.start !== offset ||
						page.view.slice.range.end !== end ||
						page.view.slice.sliceSha256 !==
							createHash("sha256").update(page.bytes).digest("hex") ||
						page.sourceWork.parentScans !== 0 ||
						page.sourceWork.bytesRead > page.bytes.byteLength * 2 + pageBytes
					)
						target.failures.push(
							`operation ${target.operations} violated paging invariants`,
						);
				} catch (error) {
					target.failures.push(
						`operation ${target.operations}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}),
		);
		operations += count;
		batches += 1;
		resourceSamples.push({
			operation: operations,
			elapsedMs: input.policy.now() - startedAt,
			sample: await measureResources(),
		});
		if (input.policy.waitUntil && operations <= requiredOperations) {
			await input.policy.waitUntil(
				(requiredDurationMs * operations) / requiredOperations,
			);
		}
	} while (
		operations < requiredOperations ||
		input.policy.now() - startedAt < requiredDurationMs
	);
	const durationMs = input.policy.now() - startedAt;
	const warmupOperations =
		requiredOperations < PROGRESSIVE_CONTENT_SOAK_SAMPLE_EVERY_OPERATIONS * 2
			? 0
			: Math.min(10_000, Math.floor(requiredOperations / 10));
	const analyzedResourceDrift = analyzeProgressiveContentResourceDrift({
		samples: resourceSamples,
		warmupOperations,
	});
	const walGrowthBytes =
		(resourceSamples.at(-1)?.sample.walBytes ?? 0) -
		(resourceSamples[0]?.sample.walBytes ?? 0);
	const resourceDrift: ProgressiveContentResourceDrift =
		walGrowthBytes > 0
			? {
					...analyzedResourceDrift,
					status: "failed",
					walGrowthBytes,
					failures: [
						...analyzedResourceDrift.failures,
						`wal bytes grew by ${walGrowthBytes}`,
					],
				}
			: analyzedResourceDrift;
	const positiveLeakControlSamples =
		await runRealPositiveLeakControl(measureResources);
	const positiveLeakControlDrift = analyzeProgressiveContentResourceDrift({
		samples: positiveLeakControlSamples.map((sample, operation) => ({
			operation,
			elapsedMs: operation,
			sample,
		})),
	});
	const positiveLeakControlDetected =
		positiveLeakControlDrift.status === "failed";
	const failures = familyState.flatMap(({ family, failures }) =>
		failures.map((failure) => `${family}: ${failure}`),
	);
	if (resourceDrift.status === "failed")
		failures.push(...resourceDrift.failures);
	if (!positiveLeakControlDetected)
		failures.push("positive leak control was not detected");
	const evidenceEligible =
		input.policy.clockSource === "system-monotonic" &&
		requiredDurationMs === REQUIRED_PROGRESSIVE_CONTENT_SOAK_DURATION_MS &&
		requiredOperations === REQUIRED_PROGRESSIVE_CONTENT_SOAK_OPERATIONS &&
		batchOperations === PROGRESSIVE_CONTENT_SOAK_SAMPLE_EVERY_OPERATIONS;
	return {
		schemaVersion: PROGRESSIVE_CONTENT_MIXED_SOAK_SCHEMA_VERSION,
		commit: input.commit,
		corpusManifestSha256: input.corpusManifestSha256,
		clockSource: input.policy.clockSource,
		evidenceEligible,
		status: failures.length === 0 ? "passed" : "failed",
		durationMs,
		operations,
		requiredDurationMs,
		requiredOperations,
		sampleEveryOperations: PROGRESSIVE_CONTENT_SOAK_SAMPLE_EVERY_OPERATIONS,
		warmupOperations,
		batches,
		failures,
		families: familyState.map((target) => ({
			family: target.family,
			adapterId: target.adapter.adapterId,
			objectId: target.object.id,
			authoritativeStore: target.authoritativeStore,
			productionMethod: target.productionMethod,
			binaryPolicy: target.binaryPolicy,
			operations: target.operations,
			failures: target.failures,
			sourceWork: {
				bytesRead: target.bytesRead,
				readCalls: target.readCalls,
				rowsRead: target.rowsRead,
				parentScans: target.parentScans,
			},
		})),
		resourceSamples,
		resourceDrift,
		positiveLeakControlDetected,
		positiveLeakControlKind: "retained-array-buffer",
		positiveLeakControlSamples,
		positiveLeakControlDrift,
	};
}

/** Run the fixed production evidence contract; this call intentionally lasts at least six hours. */
export function runProgressiveContentMixedSoak(input: {
	readonly commit: string;
	readonly corpusManifestSha256: string;
	readonly targets: readonly ProgressiveContentSoakTarget[];
	readonly measureResources: () =>
		| ProgressiveContentMixedResourceSample
		| Promise<ProgressiveContentMixedResourceSample>;
}): Promise<ProgressiveContentMixedSoakReport> {
	const startedAt = performance.now();
	return runProgressiveContentMixedSoakContract({
		...input,
		policy: {
			requiredDurationMs: REQUIRED_PROGRESSIVE_CONTENT_SOAK_DURATION_MS,
			requiredOperations: REQUIRED_PROGRESSIVE_CONTENT_SOAK_OPERATIONS,
			batchOperations: PROGRESSIVE_CONTENT_SOAK_SAMPLE_EVERY_OPERATIONS,
			now: () => performance.now(),
			waitUntil: async (targetElapsedMs) => {
				const remainingMs = targetElapsedMs - (performance.now() - startedAt);
				if (remainingMs > 0)
					await new Promise<void>((resolve) =>
						setTimeout(resolve, remainingMs),
					);
			},
			clockSource: "system-monotonic",
		},
	});
}
