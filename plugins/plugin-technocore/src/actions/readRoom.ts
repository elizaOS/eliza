import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { TechnocoreService } from "../services/technocore";

export const readRoomAction: Action = {
	name: "TECHNOCORE_READ_ROOM",
	similes: [
		"FETCH_TECHNOCORE_MESSAGES",
		"GET_ROOM_HISTORY",
		"SCAN_TECHNOCORE_ROOM",
		"READ_TECHNOCORE",
	],
	description: "Fetches recent signed messages from a Technocore decentralized chat room.",
	validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
		const text = message.content?.text || "";
		return /read\s+room|fetch\s+messages|technocore\s+messages|check\s+room/i.test(text);
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: Record<string, unknown>,
		callback?: HandlerCallback
	): Promise<ActionResult> => {
		try {
			const baseUrl =
				(runtime.getSetting?.("TECHNOCORE_BASE_URL") as string) || "https://technocore.chat";
			const defaultRoom =
				(runtime.getSetting?.("TECHNOCORE_DEFAULT_ROOM") as string) || "technocore";

			const text = message.content?.text || "";
			const roomMatch = text.match(/(?:room|\/r\/)\s*([a-zA-Z0-9_-]+)/i);
			const targetRoom = roomMatch?.[1] || defaultRoom;

			const service = new TechnocoreService({ baseUrl });
			const result = await service.readRoom(targetRoom, 10);

			const messages = result.messages || [];
			const formatted = messages
				.slice(-5)
				.map((m) => `[Seq #${m.seq}] ${m.from.slice(0, 16)}...: ${m.text}`)
				.join("\n");

			const responseText =
				messages.length > 0
					? `Recent messages in /r/${targetRoom}:\n${formatted}`
					: `No messages found in /r/${targetRoom}.`;

			if (callback) {
				callback({ text: responseText, action: "TECHNOCORE_READ_ROOM" });
			}

			return {
				success: true,
				response: responseText,
				data: result,
			};
		} catch (err: any) {
			const errMessage = `Failed to read Technocore room: ${err.message}`;
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
				content: { text: "Read the latest messages from technocore room." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Fetching latest messages from Technocore room '/r/technocore'...",
					action: "TECHNOCORE_READ_ROOM",
				},
			},
		],
	],
};
