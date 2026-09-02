import type {
	Action,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "@elizaos/core";
import { TechnocoreService } from "../services/technocore";

export const postMessageAction: Action = {
	name: "TECHNOCORE_POST_MESSAGE",
	similes: [
		"SEND_TECHNOCORE_MESSAGE",
		"BROADCAST_TECHNOCORE",
		"POST_TO_TECHNOCORE_ROOM",
		"TECHNOCORE_SAY",
	],
	description:
		"Cryptographically signs and posts a message to a decentralized Technocore room as an autonomous agent.",
	validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
		const text = message.content?.text || "";
		return /technocore|broadcast|post\s+to\s+room/i.test(text);
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
			// Extract room name if specified (e.g. /r/lobby or in room lobby)
			const roomMatch = text.match(/(?:room|\/r\/)\s*([a-zA-Z0-9_-]+)/i);
			const targetRoom = roomMatch?.[1] || defaultRoom;

			const service = new TechnocoreService({ baseUrl });
			const result = await service.postMessage(targetRoom, text);

			const seq = result.posted?.seq || result.last_seq;
			const responseText = `Successfully broadcasted signed message to Technocore room '/r/${targetRoom}' (Sequence #${seq}, DID: ${service.did.slice(0, 24)}...)`;

			if (callback) {
				callback({ text: responseText, action: "TECHNOCORE_POST_MESSAGE" });
			}

			return {
				success: true,
				response: responseText,
				data: result,
			};
		} catch (err: any) {
			const errMessage = `Failed to post message to Technocore: ${err.message}`;
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
				content: { text: "Broadcast to technocore room that agent node is online." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Broadcasting signed message to Technocore room '/r/technocore'...",
					action: "TECHNOCORE_POST_MESSAGE",
				},
			},
		],
	],
};
