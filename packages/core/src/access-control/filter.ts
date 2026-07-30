/**
 * Read-side access-control filter for memory-shaped retrieval records: maps an
 * {@link AccessContext} to a scope-ladder actor, decides whether that actor may
 * read a record of a given {@link MemoryScope}, and subtractively filters a
 * result array down to the readable set.
 *
 * Composes with — never duplicates — Postgres RLS: RLS gates on
 * `entity_id`/`server_id`, this gates on `metadata.scope`. Document fragments
 * must not delegate authorization here: their denormalized metadata is not
 * authoritative, and document ADMIN semantics differ. Document reads authorize
 * the stored parent through the adapter capability before ranking. An
 * unresolved role fails closed to the least-privileged `USER` tier.
 */
import { isAdminRank, type RoleName } from "../roles";
import type { AccessContext, MemoryScope, UUID } from "../types";

interface AccessScopedRecord {
	entityId?: UUID;
	metadata?: {
		scope?: unknown;
		scopedToEntityId?: unknown;
		addedBy?: unknown;
	};
}

function isMemoryScope(value: unknown): value is MemoryScope {
	switch (value) {
		case "shared":
		case "private":
		case "room":
		case "global":
		case "owner-private":
		case "user-private":
		case "agent-private":
			return true;
		default:
			return false;
	}
}

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
 * Whether `actor` may read a memory of the given `scope`. The generic core
 * scopes fold in: `shared`/`room` read like `global`, `private` like
 * `user-private`. `scopedEntityId` is the memory's owning entity (used only by
 * the entity-scoped tiers); `opts.scopedToEntityId` lets an OWNER read on behalf
 * of a specific entity.
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
 * Filter retrieval records down to those `ctx`'s requester may read. A pure,
 * strictly subtractive `.filter()`: it composes with (never duplicates)
 * Postgres RLS, which gates on `entity_id`/`server_id` while this gates on
 * `metadata.scope`. Scope defaults to `global` only when absent; malformed
 * scopes fail closed. The owning entity is taken from
 * `metadata.scopedToEntityId`, else `metadata.addedBy`, else `entityId`
 * (mirroring the documents plugin).
 */
export function filterByAccessContext<T extends AccessScopedRecord>(
	memories: T[],
	ctx: AccessContext,
	agentId: UUID,
): T[] {
	const actor = actorFromAccessContext(ctx, agentId);
	return memories.filter((memory) => {
		const rawScope = memory.metadata?.scope;
		if (rawScope !== undefined && !isMemoryScope(rawScope)) {
			return false;
		}
		const scope = rawScope ?? "global";
		const meta = memory.metadata;
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
