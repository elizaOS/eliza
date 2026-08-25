/** Defines and executes the fail-closed cross-stage progressive-content fault matrix. */

export const PROGRESSIVE_CONTENT_FAULT_SCHEMA_VERSION =
	"elizaos.progressive-content.faults.v1" as const;

export const PROGRESSIVE_CONTENT_FORBIDDEN_FAULT_EFFECTS = [
	"partial-success",
	"unauthorized-bytes",
	"orphaned-publication",
	"silent-skip",
] as const;

export const PROGRESSIVE_CONTENT_FAULT_CASES = [
	["unauthorized", "authorize", "CONTENT_ACCESS_DENIED"],
	["revoked-authorization", "authorize", "CONTENT_ACCESS_REVOKED"],
	["stale-revision", "continuation", "CONTENT_STALE_REVISION"],
	["missing-source", "resolve", "CONTENT_NOT_FOUND"],
	["tampered-reference", "resolve", "CONTENT_REFERENCE_INVALID"],
	["concurrent-cleanup", "cleanup", "CONTENT_NOT_FOUND"],
	["resolve-timeout", "resolve", "CONTENT_RESOLVE_TIMEOUT"],
	["read-cancellation", "read", "CONTENT_READ_CANCELLED"],
	["short-read", "read", "CONTENT_SHORT_READ"],
	["mid-page-error", "read", "CONTENT_READ_FAILED"],
	["stat-read-toctou", "stat", "CONTENT_STALE_REVISION"],
	["metadata-body-split-brain", "read", "CONTENT_INTEGRITY_MISMATCH"],
	["concurrent-replace", "continuation", "CONTENT_STALE_REVISION"],
	["index-lag", "search", "CONTENT_INDEX_STALE"],
	["client-backpressure", "transport", "CONTENT_READ_CANCELLED"],
	["decompression-bomb", "extract", "CONTENT_EXTRACTION_LIMIT"],
	["corrupted-manifest", "continuity", "CONTENT_MANIFEST_CORRUPT"],
	["process-death", "persist", "CONTENT_PUBLICATION_INCOMPLETE"],
	["digest-mismatch", "read", "CONTENT_INTEGRITY_MISMATCH"],
	["provider-401", "connector", "CONNECTOR_UNAUTHORIZED"],
	["provider-403", "connector", "CONNECTOR_FORBIDDEN"],
	["provider-404", "connector", "CONNECTOR_NOT_FOUND"],
	["provider-409", "connector", "CONNECTOR_CONFLICT"],
	["provider-429", "connector", "CONNECTOR_RATE_LIMITED"],
	["provider-5xx", "connector", "CONNECTOR_UPSTREAM_FAILED"],
	["disk-full", "persist", "CONTENT_STORAGE_FULL"],
	["retention-expiry", "authorize", "CONTENT_EXPIRED"],
	["database-commit", "commit", "CONTENT_COMMIT_FAILED"],
	["connector-refresh", "connector", "CONNECTOR_REFRESH_FAILED"],
	["compaction-failure", "continuity", "CONTENT_MANIFEST_COMMIT_FAILED"],
	["cleanup-failure", "cleanup", "CONTENT_CLEANUP_FAILED"],
] as const;

export type ProgressiveContentFaultId =
	(typeof PROGRESSIVE_CONTENT_FAULT_CASES)[number][0];

export interface ProgressiveContentFaultReport {
	readonly schemaVersion: typeof PROGRESSIVE_CONTENT_FAULT_SCHEMA_VERSION;
	readonly status: "passed" | "failed";
	readonly required: number;
	readonly executed: number;
	readonly catalog: readonly ProgressiveContentFaultId[];
	readonly results: readonly {
		readonly id: ProgressiveContentFaultId;
		readonly stage: string;
		readonly expectedCode: string;
		readonly forbiddenEffects: readonly string[];
		readonly status: "passed" | "failed";
		readonly observedCode?: string;
		readonly observedEffects: readonly string[];
	}[];
}

/** Run every registered injector; missing injectors remain failed report rows. */
export async function runProgressiveContentFaultRegistry(input: {
	readonly executors: Partial<
		Record<
			ProgressiveContentFaultId,
			() =>
				| Promise<{
						readonly code: string;
						readonly effects?: readonly string[];
				  }>
				| {
						readonly code: string;
						readonly effects?: readonly string[];
				  }
		>
	>;
}): Promise<ProgressiveContentFaultReport> {
	let executed = 0;
	const results: ProgressiveContentFaultReport["results"][number][] = [];
	for (const [id, stage, expectedCode] of PROGRESSIVE_CONTENT_FAULT_CASES) {
		const executor = input.executors[id];
		let observedCode: string | undefined;
		let observedEffects: readonly string[] = ["executor-missing"];
		if (executor) {
			executed += 1;
			try {
				const observed = await executor();
				observedCode = observed.code;
				observedEffects = observed.effects ?? [];
			} catch (error) {
				observedCode = `executor-error:${
					error instanceof Error ? error.name : "unknown"
				}`;
				observedEffects = [];
			}
		}
		const forbiddenEffects = PROGRESSIVE_CONTENT_FORBIDDEN_FAULT_EFFECTS;
		results.push({
			id,
			stage,
			expectedCode,
			forbiddenEffects,
			status:
				observedCode === expectedCode &&
				observedEffects.every(
					(effect) =>
						!forbiddenEffects.some((forbidden) => forbidden === effect),
				)
					? "passed"
					: "failed",
			...(observedCode ? { observedCode } : {}),
			observedEffects,
		});
	}
	return {
		schemaVersion: PROGRESSIVE_CONTENT_FAULT_SCHEMA_VERSION,
		status:
			executed === PROGRESSIVE_CONTENT_FAULT_CASES.length &&
			results.every(({ status }) => status === "passed")
				? "passed"
				: "failed",
		required: PROGRESSIVE_CONTENT_FAULT_CASES.length,
		executed,
		catalog: PROGRESSIVE_CONTENT_FAULT_CASES.map(([id]) => id),
		results,
	};
}
