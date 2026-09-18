/**
 * Resolves component visibility from current authority and derives stable agent-scoped identities.
 * Resolve each source role before filtering: raw stored grants may be stale or
 * demoted by canonical ownership. Return copies so filtering cannot mutate storage.
 */
import type { RolesWorldMetadata } from "./roles";
import type { Entity, IAgentRuntime, UUID, World } from "./types";
import { stringToUuid } from "./utils";
export async function resolveTrustedComponentSourceIds(
	runtime: IAgentRuntime,
	world: World | null,
	components: NonNullable<Entity["components"]>,
): Promise<Set<string>> {
	const trusted = new Set<string>();
	if (!world) return trusted;

	const sourceIds = new Set<string>();
	for (const component of components) {
		if (component.sourceEntityId) {
			sourceIds.add(component.sourceEntityId);
		}
	}
	if (sourceIds.size === 0) return trusted;

	const { resolveEntityRole, isAdminRank } = await import("./roles");
	const metadata = (world.metadata ?? {}) as RolesWorldMetadata;
	await Promise.all(
		[...sourceIds].map(async (sourceEntityId) => {
			const role = await resolveEntityRole(
				runtime,
				world,
				metadata,
				sourceEntityId,
			);
			if (isAdminRank(role)) {
				trusted.add(sourceEntityId);
			}
		}),
	);
	return trusted;
}

function visibleComponents(
	entity: Entity,
	messageEntityId: UUID,
	agentId: UUID,
	trustedSourceIds: Set<string>,
): NonNullable<Entity["components"]> {
	return (entity.components ?? []).filter((component) => {
		if (component.sourceEntityId === messageEntityId) return true;
		if (entity.id && component.sourceEntityId === entity.id) return true;
		if (
			component.sourceEntityId &&
			trustedSourceIds.has(component.sourceEntityId)
		) {
			return true;
		}
		if (component.sourceEntityId === agentId) return true;
		return false;
	});
}

export async function withVisibleComponents(
	runtime: IAgentRuntime,
	world: World | null,
	entity: Entity,
	messageEntityId: UUID,
): Promise<Entity> {
	if (!entity.components) {
		return { ...entity };
	}
	const trustedSourceIds = await resolveTrustedComponentSourceIds(
		runtime,
		world,
		entity.components,
	);
	return {
		...entity,
		components: visibleComponents(
			entity,
			messageEntityId,
			runtime.agentId,
			trustedSourceIds,
		),
	};
}

export const createUniqueUuid = (
	runtime: IAgentRuntime,
	baseUserId: UUID | string,
): UUID => {
	if (baseUserId === runtime.agentId) {
		return runtime.agentId;
	}

	const combinedString = `${baseUserId}:${runtime.agentId}`;
	return stringToUuid(combinedString);
};
