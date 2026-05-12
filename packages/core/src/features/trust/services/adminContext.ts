import { createUniqueUuid } from "../../../entities.ts";
import {
	ChannelType,
	type IAgentRuntime,
	type Memory,
	Role,
	type State,
	type UUID,
} from "../../../types/index.ts";

export async function resolveAdminContext(
	runtime: IAgentRuntime,
	message: Memory,
	state?: State,
): Promise<boolean> {
	const ownerEntityId = runtime.getSetting("OWNER_ENTITY_ID");
	if (ownerEntityId && message.entityId === ownerEntityId) {
		return true;
	}

	const room = state?.data?.room ?? (await runtime.getRoom?.(message.roomId));
	if (!room) {
		return false;
	}

	// In direct user<->agent chats, the requester is trusted-admin context.
	if (room.type === ChannelType.DM) {
		return true;
	}

	if (room.type !== ChannelType.GROUP) {
		return false;
	}

	const configuredWorldId = runtime.getSetting("WORLD_ID");
	const worldId =
		(typeof room.worldId === "string" && room.worldId) ||
		(typeof configuredWorldId === "string" && configuredWorldId) ||
		(room.messageServerId
			? createUniqueUuid(runtime, room.messageServerId)
			: undefined);

	if (!worldId) {
		return false;
	}

	const world = await runtime.getWorld(worldId as UUID);
	const roles =
		(world?.metadata?.roles as Record<string, string> | undefined) ?? {};
	const role = roles[message.entityId];
	return role === Role.ADMIN || role === Role.OWNER;
}
