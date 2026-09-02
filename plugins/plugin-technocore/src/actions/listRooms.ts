import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { TechnocoreService } from "../services/technocore";

function getTechnocoreService(runtime: IAgentRuntime): TechnocoreService {
	return (
		(runtime.getService?.("technocore") as TechnocoreService) ||
		new TechnocoreService(runtime)
	);
}

export const listRoomsAction: Action = {
	name: "TECHNOCORE_LIST_ROOMS",
	similes: [
		"DISCOVER_TECHNOCORE_ROOMS",
		"LIST_CHAT_ROOMS",
		"SCAN_TECHNOCORE_NETWORK",
	],
	description: "Discovers all active communication rooms across the Technocore decentralized network.",
	validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
		const text = message.content?.text || "";
		return /list\s+rooms|discover\s+rooms|technocore\s+rooms/i.test(text);
	},
	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		_options?: Record<string, unknown>,
		callback?: HandlerCallback
	): Promise<ActionResult> => {
		try {
			const service = getTechnocoreService(runtime);
			const result = await service.listRooms();

			const roomList = (result.rooms || [])
				.map((r) => `/r/${r.room} (last seq: ${r.last_seq})`)
				.join("\n");

			const responseText = `Active Technocore Rooms (${result.total || 0} total):\n${roomList}`;

			if (callback) {
				callback({ text: responseText, action: "TECHNOCORE_LIST_ROOMS" });
			}

			return {
				success: true,
				response: responseText,
				data: result,
			};
		} catch (err: any) {
			const errMessage = `Failed to list Technocore rooms: ${err.message}`;
			if (callback) {
				callback({ text: errMessage, error: true });
			}
			return {
				success: false,
				error: errMessage,
			};
		}
	},
	examples: [
		[
			{
				name: "{{user}}",
				content: { text: "What rooms are active on Technocore?" },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Scanning Technocore network for active rooms...",
					action: "TECHNOCORE_LIST_ROOMS",
				},
			},
		],
	],
};
