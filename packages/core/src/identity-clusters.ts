/**
 * Optional-capability bridge to the "relationships" service for identity-cluster
 * resolution: `getRelatedEntityIds` expands an entity id to its cluster members
 * and `resolvePrimaryEntityId` collapses an alias to its canonical primary id.
 * Degrades to the identity function when the service, or the relevant method, is
 * absent, so callers can treat clustering as best-effort.
 */
import type { IAgentRuntime, Service, UUID } from "./types/index.ts";

type IdentityClusterResolver = Service & {
	getMemberEntityIds?: (entityId: UUID) => Promise<UUID[]>;
	resolvePrimaryEntityId?: (entityId: UUID) => Promise<UUID>;
};

// Short-TTL, in-flight-shared memo for cluster expansion. Every warm chat turn
// resolves the sender's cluster more than once — FACTS and RECENT_MESSAGES both
// call getRelatedEntityIds, and the planner recompose calls them again — each
// running the same multi-query union-find BFS against the single-threaded
// PGlite store, which serializes behind every other provider and sets the
// composeState wall. Cluster membership only changes on rare, human-approved
// identity-merge/link events, so a brief memo collapses the duplicate BFS with
// no prompt-content change on ordinary turns. The stored value is the promise,
// so concurrent callers within one compose share a single in-flight query even
// before the TTL matters; a rejected lookup is evicted so failures are retried.
const CLUSTER_MEMO_TTL_MS = 30_000;
const CLUSTER_MEMO_MAX = 1_000;
const clusterMemo = new Map<string, { at: number; promise: Promise<UUID[]> }>();

function getIdentityClusterResolver(
	runtime: IAgentRuntime,
): IdentityClusterResolver | null {
	const service = runtime.getService("relationships");
	if (!service) {
		return null;
	}
	if (
		typeof (service as IdentityClusterResolver).getMemberEntityIds !==
			"function" &&
		typeof (service as IdentityClusterResolver).resolvePrimaryEntityId !==
			"function"
	) {
		return null;
	}
	return service as IdentityClusterResolver;
}

export async function getRelatedEntityIds(
	runtime: IAgentRuntime,
	entityId: UUID,
): Promise<UUID[]> {
	const resolver = getIdentityClusterResolver(runtime);
	if (!resolver?.getMemberEntityIds) {
		return [entityId];
	}
	const getMemberEntityIds = resolver.getMemberEntityIds.bind(resolver);

	const key = `${runtime.agentId}:${entityId}`;
	const now = Date.now();
	const cached = clusterMemo.get(key);
	if (cached && now - cached.at < CLUSTER_MEMO_TTL_MS) {
		return cached.promise;
	}

	const promise = (async () => {
		const relatedEntityIds = await getMemberEntityIds(entityId);
		const deduped = Array.from(new Set([entityId, ...relatedEntityIds]));
		return deduped.length > 0 ? deduped : [entityId];
	})();
	promise.catch(() => clusterMemo.delete(key));

	if (clusterMemo.size >= CLUSTER_MEMO_MAX) {
		const oldest = clusterMemo.keys().next().value;
		if (oldest !== undefined) clusterMemo.delete(oldest);
	}
	clusterMemo.set(key, { at: now, promise });
	return promise;
}

/**
 * Drop a memoized cluster (or the whole memo) so the next resolution re-queries
 * live. Call after an identity merge/link so cross-turn recall reflects the new
 * membership immediately instead of waiting out the TTL.
 */
export function invalidateRelatedEntityIds(
	runtime: IAgentRuntime,
	entityId?: UUID,
): void {
	if (entityId === undefined) {
		clusterMemo.clear();
		return;
	}
	clusterMemo.delete(`${runtime.agentId}:${entityId}`);
}

export async function resolvePrimaryEntityId(
	runtime: IAgentRuntime,
	entityId: UUID,
): Promise<UUID> {
	const resolver = getIdentityClusterResolver(runtime);
	if (!resolver?.resolvePrimaryEntityId) {
		return entityId;
	}
	return resolver.resolvePrimaryEntityId(entityId);
}
