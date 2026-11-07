import type { Room } from "./types/environment.js";
import { MESSAGE_SOURCE_CLIENT_CHAT } from "./types/message-source.js";
import type { IAgentRuntime } from "./types/runtime.js";

/**
 * The agent's `client_chat` rooms in every world. It reads by participant,
 * not by world: the web-chat world id comes from an agent name.
 */
export async function getClientChatRooms(
	runtime: IAgentRuntime,
): Promise<Room[]> {
	const rooms = await runtime.getRoomsByIds(
		await runtime.getRoomsForParticipant(runtime.agentId),
	);
	return rooms.filter((room) => room.source === MESSAGE_SOURCE_CLIENT_CHAT);
}
