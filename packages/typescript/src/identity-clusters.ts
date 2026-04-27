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

	const relatedEntityIds = await resolver.getMemberEntityIds(entityId);
	const deduped = Array.from(new Set([entityId, ...relatedEntityIds]));
	return deduped.length > 0 ? deduped : [entityId];
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
