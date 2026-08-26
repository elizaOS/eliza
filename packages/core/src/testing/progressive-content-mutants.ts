/** Executes concrete adapter faults and records which conformance vector rejected each mutant. */

import type { ReadView } from "../types/content";
import {
	type ProgressiveConformanceObject,
	type ProgressiveContentConformanceAdapter,
	type ProgressiveContentPerformanceCeilings,
	runProgressiveContentConformance,
} from "./progressive-content-conformance";

export const PROGRESSIVE_CONTENT_MUTANT_SCHEMA_VERSION =
	"elizaos.progressive-content.mutants.v2" as const;
export const PROGRESSIVE_CONTENT_MUTANT_REGISTRY_SCHEMA_VERSION =
	"elizaos.progressive-content.mutant-registry.v1" as const;

export const PROGRESSIVE_CONTENT_MUTANTS = [
	["whole-source-materialization", "adapter.source-work", "source-work"],
	["missing-expected-revision", "adapter.revision", "stale-revision"],
	["malformed-text-boundary", "adapter.decoder", "page-hash"],
	["false-completeness", "adapter.read-view", "read-view"],
	["omitted-middle-page", "adapter.continuation", "page-hash"],
	["continuation-auth-bypass", "adapter.authorization", "authorization"],
	["repeated-page-token", "adapter.continuation", "concurrency"],
	["unbounded-row-seek", "adapter.source-work", "source-work"],
	["cleanup-noop", "adapter.cleanup", "cleanup"],
] as const;

export type ProgressiveContentMutantId =
	(typeof PROGRESSIVE_CONTENT_MUTANTS)[number][0];

export const PROGRESSIVE_CONTENT_REQUIRED_MUTANTS = [
	...PROGRESSIVE_CONTENT_MUTANTS.map(([id, seam, killingVector]) => ({
		id,
		seam,
		killingVector,
		executor: "adapter" as const,
		killingTestId: `progressive-content-conformance:${id}`,
	})),
	{
		id: "duplicate-body-through-data",
		seam: "projection.action-result",
		killingVector: "serializer-duplication",
		executor: "projection",
		killingTestId: "model-input-projection:no-duplicate-body",
	},
	{
		id: "first-item-starvation",
		seam: "projection.fair-share",
		killingVector: "fairness",
		executor: "projection",
		killingTestId: "model-input-projection:fair-item-identity",
	},
	{
		id: "budget-before-final-serialization",
		seam: "prepared-request.final-wire",
		killingVector: "final-wire-budget",
		executor: "final-wire",
		killingTestId: "prepared-model-request:serialized-token-budget",
	},
	{
		id: "readback-artifact-identity-reexternalized",
		seam: "artifact.readback",
		killingVector: "artifact-identity",
		executor: "artifact",
		killingTestId: "shell-output-artifact:stable-readback-identity",
	},
	{
		id: "canonical-ledger-count-eviction",
		seam: "continuity.shard-writer",
		killingVector: "continuity-loss",
		executor: "continuity",
		killingTestId: "session-summary-manifest:count-rollover-lossless",
	},
	{
		id: "canonical-ledger-byte-eviction",
		seam: "continuity.shard-writer",
		killingVector: "continuity-loss",
		executor: "continuity",
		killingTestId: "session-summary-manifest:byte-rollover-lossless",
	},
	{
		id: "manifest-next-link-broken",
		seam: "continuity.shard-chain",
		killingVector: "manifest-chain",
		executor: "continuity",
		killingTestId: "session-summary-manifest:broken-link",
	},
	{
		id: "manifest-next-link-skip",
		seam: "continuity.shard-chain",
		killingVector: "manifest-chain",
		executor: "continuity",
		killingTestId: "session-summary-manifest:skipped-link",
	},
	{
		id: "manifest-next-link-repeat",
		seam: "continuity.shard-chain",
		killingVector: "manifest-chain",
		executor: "continuity",
		killingTestId: "session-summary-manifest:repeated-link",
	},
	{
		id: "manifest-next-link-loop",
		seam: "continuity.shard-chain",
		killingVector: "manifest-chain",
		executor: "continuity",
		killingTestId: "session-summary-manifest:cyclic-link",
	},
	{
		id: "manifest-shard-reorder",
		seam: "continuity.shard-chain",
		killingVector: "manifest-chain",
		executor: "continuity",
		killingTestId: "session-summary-manifest:ordered-chain",
	},
	{
		id: "manifest-shard-digest-mismatch",
		seam: "continuity.shard-integrity",
		killingVector: "manifest-chain",
		executor: "continuity",
		killingTestId: "session-summary-manifest:digest-mismatch",
	},
	{
		id: "selected-live-credentials-become-skip",
		seam: "scenario.live-credentials",
		killingVector: "live-credentials",
		executor: "live-credential",
		killingTestId: "scenario-runner:selected-live-missing-credentials-fails",
	},
] as const;

export type ProgressiveContentRequiredMutant =
	(typeof PROGRESSIVE_CONTENT_REQUIRED_MUTANTS)[number];
export type ProgressiveContentRequiredMutantId =
	ProgressiveContentRequiredMutant["id"];
export type ProgressiveContentExternalMutantId = Exclude<
	ProgressiveContentRequiredMutantId,
	ProgressiveContentMutantId
>;

export interface ProgressiveContentExternalMutantExecutor {
	/** Execute the mutated production seam; the owning oracle must reject it. */
	execute(): void | Promise<void>;
}

export interface ProgressiveContentMutantRegistryReport {
	readonly schemaVersion: typeof PROGRESSIVE_CONTENT_MUTANT_REGISTRY_SCHEMA_VERSION;
	readonly required: number;
	readonly executed: number;
	readonly killed: number;
	readonly killRate: number;
	readonly status: "passed" | "failed";
	readonly results: readonly {
		readonly id: ProgressiveContentRequiredMutantId;
		readonly seam: string;
		readonly killingVector: string;
		readonly executor: ProgressiveContentRequiredMutant["executor"];
		readonly killingTestId: string;
		readonly status: "killed" | "survived";
		readonly failureVectors: readonly string[];
	}[];
}

export interface ProgressiveContentMutantReport {
	readonly schemaVersion: typeof PROGRESSIVE_CONTENT_MUTANT_SCHEMA_VERSION;
	readonly required: number;
	readonly executed: number;
	readonly killed: number;
	readonly killRate: number;
	readonly status: "passed" | "failed";
	readonly results: readonly {
		readonly id: ProgressiveContentMutantId;
		readonly seam: string;
		readonly killingVector: string;
		readonly status: "killed" | "survived";
		readonly failureVectors: readonly string[];
	}[];
}

function mutatedView(
	view: ReadView,
	update: Partial<ReadView["slice"]>,
): ReadView {
	return { ...view, slice: { ...view.slice, ...update } } as ReadView;
}

/** Wrap an adapter with one executable architectural defect. */
export function applyProgressiveContentMutant(
	base: ProgressiveContentConformanceAdapter,
	mutantId: ProgressiveContentMutantId,
	object: ProgressiveConformanceObject,
): ProgressiveContentConformanceAdapter {
	let zeroReads = 0;
	return {
		...base,
		adapterId: `${base.adapterId}:mutant:${mutantId}`,
		async cleanup(objectId) {
			if (mutantId !== "cleanup-noop") await base.cleanup(objectId);
		},
		async read(request) {
			const effectiveRequest =
				mutantId === "missing-expected-revision" && request.expectedRevision
					? { ...request, expectedRevision: undefined }
					: mutantId === "continuation-auth-bypass" &&
							request.authorizationScope !== object.authorizationScope
						? { ...request, authorizationScope: object.authorizationScope }
						: request;
			const page = await base.read(effectiveRequest);
			if (mutantId === "whole-source-materialization") {
				return {
					...page,
					sourceWork: {
						...page.sourceWork,
						bytesRead: object.byteLength,
						parentScans: page.sourceWork.parentScans + 1,
					},
				};
			}
			if (mutantId === "unbounded-row-seek") {
				return {
					...page,
					sourceWork: { ...page.sourceWork, rowsRead: 1_000_000 },
				};
			}
			if (mutantId === "false-completeness" && page.view.slice.hasMore) {
				return {
					...page,
					view: mutatedView(page.view, {
						hasMore: false,
						nextOffset: undefined,
						completeness: "complete",
					}),
				};
			}
			if (mutantId === "malformed-text-boundary" && request.offset === 0) {
				const bytes = Uint8Array.from(page.bytes);
				bytes[bytes.byteLength - 1] = 0xff;
				return { ...page, bytes };
			}
			if (mutantId === "omitted-middle-page" && request.offset > 0) {
				const bytes = Uint8Array.from(page.bytes);
				bytes[0] = (bytes[0] ?? 0) ^ 1;
				return { ...page, bytes };
			}
			if (mutantId === "repeated-page-token" && request.offset === 0) {
				zeroReads += 1;
				if (zeroReads >= 3) {
					const bytes = Uint8Array.from(page.bytes);
					bytes[0] = (bytes[0] ?? 0) ^ 1;
					return { ...page, bytes };
				}
			}
			return page;
		},
	};
}

/** Execute each required mutant against a fresh production-shaped adapter. */
export async function runProgressiveContentMutants(input: {
	readonly object: ProgressiveConformanceObject;
	readonly createAdapter: () => ProgressiveContentConformanceAdapter;
	readonly performanceCeilings?: Partial<ProgressiveContentPerformanceCeilings>;
}): Promise<ProgressiveContentMutantReport> {
	const results: ProgressiveContentMutantReport["results"][number][] = [];
	for (const [id, seam, killingVector] of PROGRESSIVE_CONTENT_MUTANTS) {
		const report = await runProgressiveContentConformance({
			adapter: applyProgressiveContentMutant(
				input.createAdapter(),
				id,
				input.object,
			),
			object: input.object,
			performanceCeilings: input.performanceCeilings,
		});
		const failureVectors = [
			...new Set(report.failures.map(({ vector }) => vector)),
		];
		results.push({
			id,
			seam,
			killingVector,
			status: failureVectors.includes(killingVector) ? "killed" : "survived",
			failureVectors,
		});
	}
	const killed = results.filter(({ status }) => status === "killed").length;
	return {
		schemaVersion: PROGRESSIVE_CONTENT_MUTANT_SCHEMA_VERSION,
		required: PROGRESSIVE_CONTENT_MUTANTS.length,
		executed: results.length,
		killed,
		killRate: killed / PROGRESSIVE_CONTENT_MUTANTS.length,
		status: killed === PROGRESSIVE_CONTENT_MUTANTS.length ? "passed" : "failed",
		results,
	};
}

/** Execute the complete cross-seam catalog; absent seam executors fail closed. */
export async function runProgressiveContentMutantRegistry(input: {
	readonly object: ProgressiveConformanceObject;
	readonly createAdapter: () => ProgressiveContentConformanceAdapter;
	readonly externalExecutors: Partial<
		Record<
			ProgressiveContentExternalMutantId,
			ProgressiveContentExternalMutantExecutor
		>
	>;
	readonly performanceCeilings?: Partial<ProgressiveContentPerformanceCeilings>;
}): Promise<ProgressiveContentMutantRegistryReport> {
	const adapterIds = new Set<ProgressiveContentMutantId>(
		PROGRESSIVE_CONTENT_MUTANTS.map(([id]) => id),
	);
	const results: ProgressiveContentMutantRegistryReport["results"][number][] =
		[];
	let executed = 0;
	for (const mutant of PROGRESSIVE_CONTENT_REQUIRED_MUTANTS) {
		let failureVectors: readonly string[];
		if (adapterIds.has(mutant.id as ProgressiveContentMutantId)) {
			executed += 1;
			const report = await runProgressiveContentConformance({
				adapter: applyProgressiveContentMutant(
					input.createAdapter(),
					mutant.id as ProgressiveContentMutantId,
					input.object,
				),
				object: input.object,
				performanceCeilings: input.performanceCeilings,
			});
			failureVectors = [
				...new Set(report.failures.map(({ vector }) => vector)),
			];
		} else {
			const executor =
				input.externalExecutors[
					mutant.id as ProgressiveContentExternalMutantId
				];
			if (!executor) {
				failureVectors = ["executor-missing"];
			} else {
				executed += 1;
				try {
					await executor.execute();
					failureVectors = ["MUTANT_NOT_OBSERVED"];
				} catch (error) {
					const vector =
						error && typeof error === "object"
							? (error as { vector?: unknown }).vector
							: undefined;
					failureVectors = [
						typeof vector === "string" && vector.length > 0
							? vector
							: `executor-error:${error instanceof Error ? error.name : "unknown"}`,
					];
				}
			}
		}
		results.push({
			...mutant,
			status: failureVectors.includes(mutant.killingVector)
				? "killed"
				: "survived",
			failureVectors,
		});
	}
	const killed = results.filter(({ status }) => status === "killed").length;
	return {
		schemaVersion: PROGRESSIVE_CONTENT_MUTANT_REGISTRY_SCHEMA_VERSION,
		required: PROGRESSIVE_CONTENT_REQUIRED_MUTANTS.length,
		executed,
		killed,
		killRate: killed / PROGRESSIVE_CONTENT_REQUIRED_MUTANTS.length,
		status:
			executed === PROGRESSIVE_CONTENT_REQUIRED_MUTANTS.length &&
			killed === PROGRESSIVE_CONTENT_REQUIRED_MUTANTS.length
				? "passed"
				: "failed",
		results,
	};
}
