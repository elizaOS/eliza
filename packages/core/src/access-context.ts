import { checkSenderRole } from "./roles";
import type { AccessContext, IAgentRuntime, Memory } from "./types";

/**
 * Build the {@link AccessContext} for a message-driven read: who is asking, in
 * which world, and with what role. `role`/`isOwner` come from the world's role
 * config via {@link checkSenderRole} and are left undefined outside a world
 * (DMs, or worlds with no role metadata), which callers must treat as "no
 * elevated access" rather than "unrestricted".
 */
export async function buildAccessContext(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<AccessContext> {
	const [roleResult, room] = await Promise.all([
		checkSenderRole(runtime, message),
		runtime.getRoom(message.roomId),
	]);
	const source = message.content?.source;
	return {
		requesterEntityId: message.entityId,
		worldId: room?.worldId,
		role: roleResult?.role,
		isOwner: roleResult?.isOwner,
		source: typeof source === "string" ? source : undefined,
	};
}
