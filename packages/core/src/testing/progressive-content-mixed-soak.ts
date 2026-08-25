/** Runs the production-eligible six-family progressive-content soak contract. */

import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import {
	PROGRESSIVE_CONTENT_FORBIDDEN_FAULT_EFFECTS,
	type ProgressiveContentFaultExecutor,
} from "./progressive-content-faults";
import {
	analyzeProgressiveContentResourceDrift,
	type ProgressiveContentResourceDrift,
	type ProgressiveContentResourcePoint,
	type ProgressiveContentResourceSample,
	REQUIRED_PROGRESSIVE_CONTENT_SOAK_DURATION_MS,
	REQUIRED_PROGRESSIVE_CONTENT_SOAK_OPERATIONS,
} from "./progressive-content-stress";
import type { ProgressiveContentTarget } from "./progressive-content-target";

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
export const PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_SCHEMA_VERSION =
	"elizaos.progressive-content.soak-lifecycle.v1" as const;
export const PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS = [
	"abort",
	"revoke",
	"mutate",
	"restart",
	"expire",
	"compaction",
	"eviction",
] as const;
export const PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_REJECTIONS = {
	abort: ["fault-rejection", "CONTENT_READ_CANCELLED"],
	revoke: ["fault-rejection", "CONTENT_ACCESS_REVOKED"],
	mutate: ["fault-rejection", "CONTENT_STALE_REVISION"],
	expire: ["fault-rejection", "CONTENT_EXPIRED"],
	compaction: ["fault-rejection", "CONTENT_MANIFEST_COMMIT_FAILED"],
	eviction: ["mutant-rejection", "CONTENT_CONTINUITY_LEDGER_MISMATCH"],
} as const;

export type ProgressiveContentSoakFamily =
	(typeof PROGRESSIVE_CONTENT_SOAK_FAMILIES)[number];
export type ProgressiveContentSoakLifecycleId =
	(typeof PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS)[number];
export type ProgressiveContentSoakLifecycleSemantics =
	| "target-transition"
	| "fault-rejection"
	| "mutant-rejection"
	| "unsupported";

export type ProgressiveContentSoakLifecycleDeclaration =
	| {
			readonly id: "restart";
			readonly semantics: "target-transition";
	  }
	| {
			readonly id: Exclude<ProgressiveContentSoakLifecycleId, "restart">;
			readonly semantics: "fault-rejection" | "mutant-rejection";
			readonly expectedCode: string;
			readonly executor: ProgressiveContentFaultExecutor;
	  }
	| {
			readonly id: Exclude<ProgressiveContentSoakLifecycleId, "restart">;
			readonly semantics: "unsupported";
			readonly reason: string;
	  };

export interface ProgressiveContentSoakLifecycleContract {
	readonly declarations: readonly ProgressiveContentSoakLifecycleDeclaration[];
}

export interface ProgressiveContentSoakLifecycleResult {
	readonly id: ProgressiveContentSoakLifecycleId;
	readonly cycle: number;
	readonly semantics: ProgressiveContentSoakLifecycleSemantics;
	readonly status: "passed" | "failed" | "unsupported";
	readonly targetFamily: ProgressiveContentSoakFamily | null;
	readonly expectedCode: string | null;
	readonly observedCode: string | null;
	readonly beforeGeneration: string | null;
	readonly afterGeneration: string | null;
	readonly beforeSliceSha256: string | null;
	readonly afterSliceSha256: string | null;
	readonly observedEffects: readonly string[];
	readonly reason: string | null;
}

export interface ProgressiveContentSoakLifecycleReport {
	readonly schemaVersion: typeof PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_SCHEMA_VERSION;
	readonly status: "passed" | "failed";
	readonly required: readonly ProgressiveContentSoakLifecycleId[];
	readonly completedCycles: number;
	readonly results: readonly ProgressiveContentSoakLifecycleResult[];
}

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
	readonly adapterId: string;
	readonly create: () =>
		| ProgressiveContentTarget
		| Promise<ProgressiveContentTarget>;
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
	readonly cleanupVerified: boolean;
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
	readonly lifecycle: ProgressiveContentSoakLifecycleReport;
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
		file: ["filesystem", "typed-rejection"],
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
			/(?:fixture|mock|stub|test)/iu.test(target.productionMethod) ||
			typeof target.adapterId !== "string" ||
			target.adapterId.length === 0 ||
			/(?:fixture|mock|stub|test)/iu.test(target.adapterId)
		)
			throw new TypeError(
				`${target.family} target does not declare its required native production realization`,
			);
	}
}

function validateLifecycleContract(
	contract: ProgressiveContentSoakLifecycleContract,
): ReadonlyMap<
	ProgressiveContentSoakLifecycleId,
	ProgressiveContentSoakLifecycleDeclaration
> {
	if (
		contract.declarations.length !==
		PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS.length
	) {
		throw new TypeError(
			"mixed soak lifecycle requires exactly seven declarations",
		);
	}
	const declarations = new Map<
		ProgressiveContentSoakLifecycleId,
		ProgressiveContentSoakLifecycleDeclaration
	>();
	for (const declaration of contract.declarations) {
		if (
			!PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS.includes(declaration.id) ||
			declarations.has(declaration.id)
		) {
			throw new TypeError(
				"mixed soak lifecycle declarations are invalid or duplicated",
			);
		}
		if (
			declaration.id === "restart" &&
			declaration.semantics !== "target-transition"
		) {
			throw new TypeError("restart must be a target-bound transition");
		}
		if (
			declaration.semantics === "unsupported" &&
			declaration.reason.trim().length === 0
		) {
			throw new TypeError(
				"unsupported lifecycle declarations require a reason",
			);
		}
		if (
			(declaration.semantics === "fault-rejection" ||
				declaration.semantics === "mutant-rejection") &&
			declaration.expectedCode.trim().length === 0
		) {
			throw new TypeError(
				"lifecycle rejection declarations require an expected code",
			);
		}
		if (
			declaration.id !== "restart" &&
			declaration.semantics !== "unsupported"
		) {
			const expected = PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_REJECTIONS[
				declaration.id
			] as readonly ["fault-rejection" | "mutant-rejection", string];
			if (
				declaration.semantics !== expected[0] ||
				declaration.expectedCode !== expected[1]
			) {
				throw new TypeError(
					`${declaration.id} lifecycle declaration differs from the fixed rejection contract`,
				);
			}
		}
		declarations.set(declaration.id, declaration);
	}
	if (
		PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS.some((id) => !declarations.has(id))
	) {
		throw new TypeError(
			"mixed soak lifecycle declarations lack fixed coverage",
		);
	}
	return declarations;
}

function lifecycleErrorCode(error: unknown): string {
	if (error && typeof error === "object") {
		const code = (error as { code?: unknown }).code;
		if (typeof code === "string" && code.length > 0) return code;
	}
	return `executor-error:${error instanceof Error ? error.name : "unknown"}`;
}

async function readLifecycleProbe(target: ProgressiveContentTarget) {
	return target.read({
		access: "authorized",
		offset: 0,
		limit: Math.min(64 * 1024, Math.max(1, target.object.byteLength)),
		expectedRevision: target.object.revision,
	});
}

async function executeLifecycleCycle(input: {
	readonly cycle: number;
	readonly declarations: ReadonlyMap<
		ProgressiveContentSoakLifecycleId,
		ProgressiveContentSoakLifecycleDeclaration
	>;
	readonly targets: readonly {
		readonly family: ProgressiveContentSoakFamily;
		readonly target: ProgressiveContentTarget;
	}[];
}): Promise<readonly ProgressiveContentSoakLifecycleResult[]> {
	const restartTarget = input.targets[(input.cycle - 1) % input.targets.length];
	if (!restartTarget) throw new TypeError("lifecycle restart target is absent");
	const results: ProgressiveContentSoakLifecycleResult[] = [];
	for (const id of PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS) {
		const declaration = input.declarations.get(id);
		if (!declaration)
			throw new TypeError(`lifecycle declaration ${id} is absent`);
		if (declaration.semantics === "unsupported") {
			results.push({
				id,
				cycle: input.cycle,
				semantics: "unsupported",
				status: "unsupported",
				targetFamily: null,
				expectedCode: null,
				observedCode: null,
				beforeGeneration: null,
				afterGeneration: null,
				beforeSliceSha256: null,
				afterSliceSha256: null,
				observedEffects: [],
				reason: declaration.reason,
			});
			continue;
		}
		if (declaration.semantics === "target-transition") {
			let beforeGeneration: string | null = null;
			let afterGeneration: string | null = null;
			let beforeSliceSha256: string | null = null;
			let afterSliceSha256: string | null = null;
			let observedCode: string | null = null;
			try {
				const before = await restartTarget.target.inspect();
				const beforePage = await readLifecycleProbe(restartTarget.target);
				beforeGeneration = before.resolverGeneration;
				beforeSliceSha256 = beforePage.view.slice.sliceSha256;
				await restartTarget.target.restart();
				const after = await restartTarget.target.inspect();
				const afterPage = await readLifecycleProbe(restartTarget.target);
				afterGeneration = after.resolverGeneration;
				afterSliceSha256 = afterPage.view.slice.sliceSha256;
			} catch (error) {
				observedCode = lifecycleErrorCode(error);
			}
			const passed =
				observedCode === null &&
				beforeGeneration !== null &&
				afterGeneration !== null &&
				beforeGeneration !== afterGeneration &&
				beforeSliceSha256 !== null &&
				beforeSliceSha256 === afterSliceSha256;
			results.push({
				id,
				cycle: input.cycle,
				semantics: "target-transition",
				status: passed ? "passed" : "failed",
				targetFamily: restartTarget.family,
				expectedCode: null,
				observedCode,
				beforeGeneration,
				afterGeneration,
				beforeSliceSha256,
				afterSliceSha256,
				observedEffects: [],
				reason: passed ? null : "restart did not preserve the bound page",
			});
			continue;
		}
		let observedCode = "FAULT_NOT_OBSERVED";
		let observedEffects: readonly string[] = [];
		try {
			await declaration.executor.execute();
		} catch (error) {
			observedCode = lifecycleErrorCode(error);
		}
		try {
			observedEffects = (await declaration.executor.observeEffects?.()) ?? [];
		} catch (error) {
			observedEffects = [
				`observer-error:${error instanceof Error ? error.name : "unknown"}`,
			];
		}
		const forbidden = observedEffects.some((effect) =>
			PROGRESSIVE_CONTENT_FORBIDDEN_FAULT_EFFECTS.includes(
				effect as (typeof PROGRESSIVE_CONTENT_FORBIDDEN_FAULT_EFFECTS)[number],
			),
		);
		const passed = observedCode === declaration.expectedCode && !forbidden;
		results.push({
			id,
			cycle: input.cycle,
			semantics: declaration.semantics,
			status: passed ? "passed" : "failed",
			targetFamily: null,
			expectedCode: declaration.expectedCode,
			observedCode,
			beforeGeneration: null,
			afterGeneration: null,
			beforeSliceSha256: null,
			afterSliceSha256: null,
			observedEffects,
			reason: passed ? null : "fault rejection or effect observation differed",
		});
	}
	return results;
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
	readonly lifecycle: ProgressiveContentSoakLifecycleContract;
}): Promise<ProgressiveContentMixedSoakReport> {
	validateTargets(input.targets);
	const lifecycleDeclarations = validateLifecycleContract(input.lifecycle);
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
			target: await target.create(),
		})),
	);
	if (
		new Set(realized.map(({ adapterId }) => adapterId)).size !==
			realized.length ||
		new Set(realized.map(({ target }) => target.object.id)).size !==
			realized.length
	)
		throw new TypeError(
			"mixed soak requires unique adapter and object identities",
		);
	const measureResources = async () =>
		validateResourceSample(await input.measureResources());
	for (const target of realized) {
		const expectedKind =
			target.family === "tool-output" ? "tool-result" : target.family;
		if (
			target.target.family !== target.family ||
			target.target.object.family !== expectedKind ||
			target.target.realization.reference.kind !== expectedKind
		)
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
		cleanupVerified: false,
	}));
	const resourceSamples: ProgressiveContentResourcePoint[] = [
		{ operation: 0, elapsedMs: 0, sample: await measureResources() },
	];
	const startedAt = input.policy.now();
	let operations = 0;
	let batches = 0;
	const lifecycleResults: ProgressiveContentSoakLifecycleResult[] = [];
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
					Math.ceil(target.target.object.byteLength / pageBytes),
				);
				const offset = (target.operations % pages) * pageBytes;
				target.operations += 1;
				try {
					const page = await target.target.read({
						access: "authorized",
						offset,
						limit: pageBytes,
						expectedRevision: target.target.object.revision,
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
		lifecycleResults.push(
			...(await executeLifecycleCycle({
				cycle: batches,
				declarations: lifecycleDeclarations,
				targets: familyState,
			})),
		);
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
		// The production process may already have a multi-gigabyte SQL baseline;
		// the deliberate 32 MiB allocation must be judged against the absolute
		// detector allowance, not hidden by the normal percentage ceiling.
		maximumMemoryGrowthRatio: 0,
	});
	const positiveLeakControlDetected =
		positiveLeakControlDrift.status === "failed";
	for (const state of familyState) {
		try {
			await state.target.cleanup();
			const snapshot = await state.target.inspect();
			state.cleanupVerified = !snapshot.present;
			if (!state.cleanupVerified)
				state.failures.push("cleanup left the target present");
		} catch (error) {
			state.failures.push(
				`cleanup: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	const failures = familyState.flatMap(({ family, failures }) =>
		failures.map((failure) => `${family}: ${failure}`),
	);
	if (resourceDrift.status === "failed")
		failures.push(...resourceDrift.failures);
	if (!positiveLeakControlDetected)
		failures.push("positive leak control was not detected");
	for (const result of lifecycleResults) {
		if (result.status !== "passed") {
			failures.push(
				`lifecycle ${result.id} cycle ${result.cycle}: ${result.reason ?? result.status}`,
			);
		}
	}
	const lifecycle: ProgressiveContentSoakLifecycleReport = {
		schemaVersion: PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_SCHEMA_VERSION,
		status: lifecycleResults.every(({ status }) => status === "passed")
			? "passed"
			: "failed",
		required: PROGRESSIVE_CONTENT_SOAK_LIFECYCLE_IDS,
		completedCycles: batches,
		results: lifecycleResults,
	};
	const evidenceEligible =
		input.policy.clockSource === "system-monotonic" &&
		requiredDurationMs === REQUIRED_PROGRESSIVE_CONTENT_SOAK_DURATION_MS &&
		requiredOperations === REQUIRED_PROGRESSIVE_CONTENT_SOAK_OPERATIONS &&
		batchOperations === PROGRESSIVE_CONTENT_SOAK_SAMPLE_EVERY_OPERATIONS &&
		lifecycle.status === "passed";
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
		lifecycle,
		families: familyState.map((target) => ({
			family: target.family,
			adapterId: target.adapterId,
			objectId: target.target.object.id,
			authoritativeStore: target.authoritativeStore,
			productionMethod: target.productionMethod,
			binaryPolicy: target.binaryPolicy,
			operations: target.operations,
			cleanupVerified: target.cleanupVerified,
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
	readonly lifecycle: ProgressiveContentSoakLifecycleContract;
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
