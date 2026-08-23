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

function mutatedView(view: ReadView, update: Partial<ReadView["slice"]>): ReadView {
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
