/**
 * Optional-capability bridge to the "relationships" service for identity-cluster
 * resolution: `getRelatedEntityIds` expands an entity id to its cluster members
 * and `resolvePrimaryEntityId` collapses an alias to its canonical primary id.
 * Degrades to the identity function when the service, or the relevant method, is
 * absent, so callers can treat clustering as best-effort.
 */

import {
	invalidateTurnMemo,
	invalidateTurnMemoPrefix,
	memoizeTurnWork,
} from "./trajectory-context.ts";
import type { IAgentRuntime, Service, UUID } from "./types/index.ts";

type IdentityClusterResolver = Service & {
	getMemberEntityIds?: (entityId: UUID) => Promise<UUID[]>;
	resolvePrimaryEntityId?: (entityId: UUID) => Promise<UUID>;
};

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

	const key = `identity-cluster:${runtime.agentId}:${entityId}`;
	return memoizeTurnWork(key, async () => {
		const relatedEntityIds = await getMemberEntityIds(entityId);
		const deduped = Array.from(new Set([entityId, ...relatedEntityIds]));
		return deduped.length > 0 ? deduped : [entityId];
	});
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
	const prefix = `identity-cluster:${runtime.agentId}:`;
	if (entityId === undefined) invalidateTurnMemoPrefix(prefix);
	else invalidateTurnMemo(`${prefix}${entityId}`);
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
