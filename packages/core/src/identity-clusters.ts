/**
 * Optional-capability bridge to the "relationships" service for identity-cluster
 * resolution: `getRelatedEntityIds` expands an entity id to its cluster members
 * and `resolvePrimaryEntityId` collapses an alias to its canonical primary id.
 * Degrades to the identity function when the service, or the relevant method, is
 * absent, so callers can treat clustering as best-effort.
 */

import { ElizaError } from "./errors.ts";
import {
	invalidateTurnMemo,
	invalidateTurnMemoPrefix,
	memoizeTurnWork,
} from "./trajectory-context.ts";
import type { IdentityResolutionService } from "./types/identity.ts";
import {
	type IAgentRuntime,
	type Service,
	ServiceType,
	type UUID,
} from "./types/index.ts";

type IdentityClusterResolver = Service & {
	getMemberEntityIds?: (entityId: UUID) => Promise<UUID[]>;
	getVerifiedMemberEntityIds?: (entityId: UUID) => Promise<UUID[]>;
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
		typeof (service as IdentityClusterResolver).getVerifiedMemberEntityIds !==
			"function" &&
		typeof (service as IdentityClusterResolver).resolvePrimaryEntityId !==
			"function"
	) {
		return null;
	}
	return service as IdentityClusterResolver;
}

function getIdentityAuthority(
	runtime: IAgentRuntime,
): IdentityResolutionService | null {
	return runtime.getService<IdentityResolutionService>(
		ServiceType.IDENTITY_RESOLUTION,
	);
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
 * Resolve only identities whose linkage is strong enough to authorize private
 * cross-room disclosure. A configured identity authority is canonical and
 * fail-closed; otherwise the relationships service may expose its confirmed-
 * link-only resolver. Inferred same-handle clusters never authorize this path.
 */
export async function getVerifiedRelatedEntityIds(
	runtime: IAgentRuntime,
	entityId: UUID,
): Promise<UUID[]> {
	const key = `verified-identity-cluster:${runtime.agentId}:${entityId}`;
	return memoizeTurnWork(key, async () => {
		const authority = getIdentityAuthority(runtime);
		if (authority) {
			const cluster = await authority.getCluster(runtime.agentId, entityId);
			if (!cluster) return [entityId];
			const principalIds = Array.from(
				new Set([
					entityId,
					cluster.canonicalPrincipalId,
					...cluster.principalIds,
				]),
			);
			if (
				cluster.agentId !== runtime.agentId ||
				!Number.isSafeInteger(cluster.generation) ||
				cluster.generation < 0 ||
				!cluster.principalIds.includes(entityId) ||
				!cluster.principalIds.includes(cluster.canonicalPrincipalId) ||
				principalIds.some(
					(principalId) =>
						typeof principalId !== "string" || principalId.length === 0,
				)
			) {
				throw new ElizaError("Identity authority returned an invalid cluster", {
					code: "IDENTITY_CLUSTER_INVALID",
					context: { entityId, runtimeAgentId: runtime.agentId },
				});
			}
			return principalIds;
		}

		const resolver = getIdentityClusterResolver(runtime);
		if (!resolver?.getVerifiedMemberEntityIds) return [entityId];
		const relatedEntityIds =
			await resolver.getVerifiedMemberEntityIds(entityId);
		return Array.from(new Set([entityId, ...relatedEntityIds]));
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
	const verifiedPrefix = `verified-identity-cluster:${runtime.agentId}:`;
	if (entityId === undefined) invalidateTurnMemoPrefix(prefix);
	else invalidateTurnMemo(`${prefix}${entityId}`);
	if (entityId === undefined) invalidateTurnMemoPrefix(verifiedPrefix);
	else invalidateTurnMemo(`${verifiedPrefix}${entityId}`);
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
