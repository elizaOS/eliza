import { isAdminRank, type RoleName } from "../roles";
import type { AccessContext, Memory, MemoryScope, UUID } from "../types";

/**
 * Read-side actor role: the core {@link RoleName} widened with the machine
 * tiers the scope ladder recognizes — `AGENT` (an agent reading its own store)
 * and `RUNTIME` (the documents read path that delegates to this ladder).
 * {@link actorFromAccessContext} only ever yields `OWNER`/`USER`/`AGENT`;
 * `RUNTIME` is supplied by the documents plugin, never minted from a message.
 */
export type ActorRole = RoleName | "AGENT" | "RUNTIME";

export interface ScopeActor {
	entityId: UUID;
	role: ActorRole;
}

/**
 * Collapse an {@link AccessContext} into the scope-ladder actor. A self-read
 * (requester is the agent) is `AGENT`; OWNER/ADMIN manage owner-scoped
 * memories; everyone else (USER/GUEST, or no role at all — e.g. a DM that
 * resolved no world) is `USER`, the least-privileged tier, so an unresolved
 * role fails closed rather than open.
 */
export function actorFromAccessContext(
	ctx: AccessContext,
	agentId: UUID,
): ScopeActor {
	if (ctx.requesterEntityId === agentId) {
		return { entityId: agentId, role: "AGENT" };
	}
	if (ctx.isOwner || isAdminRank(ctx.role)) {
		return { entityId: ctx.requesterEntityId, role: "OWNER" };
	}
	return { entityId: ctx.requesterEntityId, role: "USER" };
}

/**
 * Whether `actor` may read a memory of the given `scope`. For the four document
 * scopes this is byte-equivalent to the documents plugin's `canReadDocumentMemory`
 * so that plugin can delegate here without changing behavior. The generic core
 * scopes fold in: `shared`/`room` read like `global`, `private` like
 * `user-private`. `scopedEntityId` is the memory's owning entity (used only by
 * the entity-scoped tiers); `opts.scopedToEntityId` lets an OWNER read on behalf
 * of a specific entity, matching the documents filter.
 */
export function canReadScope(
	scope: MemoryScope,
	scopedEntityId: UUID | undefined,
	actor: ScopeActor,
	opts?: { scopedToEntityId?: UUID },
): boolean {
	switch (scope) {
		case "global":
		case "shared":
		case "room":
			return true;
		case "owner-private":
			return actor.role === "OWNER" || actor.role === "RUNTIME";
		case "agent-private":
			return (
				actor.role === "OWNER" ||
				actor.role === "AGENT" ||
				actor.role === "RUNTIME"
			);
		case "user-private":
		case "private": {
			if (!scopedEntityId) return false;
			if (actor.role === "AGENT" || actor.role === "RUNTIME") return true;
			if (actor.role === "OWNER") {
				return opts?.scopedToEntityId
					? scopedEntityId === opts.scopedToEntityId
					: scopedEntityId === actor.entityId;
			}
			return scopedEntityId === actor.entityId;
		}
	}
}

/**
 * Filter memories down to those `ctx`'s requester may read. A pure, strictly
 * subtractive `.filter()`: it composes with (never duplicates) Postgres RLS,
 * which gates on `entity_id`/`server_id` while this gates on `metadata.scope`.
 * Scope defaults to `global` when absent; the owning entity is taken from
 * `metadata.scopedToEntityId`, else `metadata.addedBy`, else `memory.entityId`
 * (mirroring the documents plugin).
 */
export function filterByAccessContext(
	memories: Memory[],
	ctx: AccessContext,
	agentId: UUID,
): Memory[] {
	const actor = actorFromAccessContext(ctx, agentId);
	return memories.filter((memory) => {
		const scope = memory.metadata?.scope ?? "global";
		const meta = memory.metadata as Record<string, unknown> | undefined;
		const scopedTo = meta?.scopedToEntityId;
		const addedBy = meta?.addedBy;
		const scopedEntityId =
			typeof scopedTo === "string"
				? (scopedTo as UUID)
				: typeof addedBy === "string"
					? (addedBy as UUID)
					: memory.entityId;
		return canReadScope(scope, scopedEntityId, actor);
	});
}
