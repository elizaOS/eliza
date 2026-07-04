/**
 * Assembles the {@link AccessContext} DTO — requester entity, world scope, role,
 * and owner flag — that authorization checks read for a message-driven request.
 * A thin composition over `roles.ts`: it runs role resolution against the single
 * world `resolveWorldForMessage` selects, so `worldId`, `role`, and `isOwner`
 * are always derived together and can never disagree on which world they scope.
 */
import {
	getLiveEntityMetadataFromMessage,
	resolveEntityRole,
	resolveWorldForMessage,
} from "./roles";
import type { AccessContext, IAgentRuntime, Memory } from "./types";

/**
 * Build the {@link AccessContext} for a message-driven read: who is asking, in
 * which world, and with what role.
 *
 * `worldId`, `role`, and `isOwner` are resolved together from the SINGLE world
 * that {@link resolveWorldForMessage} picks for the message — the room's
 * `worldId`, else the connector-metadata fallback (e.g. a Discord server/channel
 * id). Deriving all three from one resolution is load-bearing: resolving the
 * role against one world while reading `worldId` off a different path can yield
 * `role: "OWNER"` with `worldId: undefined` — an elevated role with no tenant
 * scope. Outside a world (DMs, or a message with no resolvable world) all three
 * are left undefined, which callers must treat as "no elevated access" rather
 * than "unrestricted".
 */
export async function buildAccessContext(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<AccessContext> {
	const requesterEntityId = message.entityId;
	const source = message.content?.source;
	const sourceField = typeof source === "string" ? source : undefined;

	const resolved = await resolveWorldForMessage(runtime, message);
	if (!resolved) {
		return { requesterEntityId, source: sourceField };
	}

	const { world, metadata } = resolved;
	const role = await resolveEntityRole(
		runtime,
		world,
		metadata,
		requesterEntityId,
		{
			liveEntityMetadata: getLiveEntityMetadataFromMessage(message),
			liveEntityId: requesterEntityId,
		},
	);

	return {
		requesterEntityId,
		worldId: world?.id,
		role,
		isOwner: role === "OWNER",
		source: sourceField,
	};
}
