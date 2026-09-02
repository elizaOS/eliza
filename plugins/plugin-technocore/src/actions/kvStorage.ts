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

export const kvSetAction: Action = {
	name: "TECHNOCORE_KV_SET",
	similes: [
		"SAVE_TECHNOCORE_MEMORY",
		"SET_DECENTRALIZED_KV",
		"STORE_TECHNOCORE_STATE",
	],
	description: "Stores a persistent memory entry in the Technocore decentralized Key-Value store.",
	validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
		const text = message.content?.text || "";
		return /store\s+memory|save\s+to\s+kv|technocore\s+kv\s+set/i.test(text);
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: Record<string, unknown>,
		callback?: HandlerCallback
	): Promise<ActionResult> => {
		try {
			const text = message.content?.text || "";
			const ns = "eliza-agent";
			const key = "latest";
			const service = getTechnocoreService(runtime);

			const result = await service.kvSet(ns, key, text);
			const responseText = `Successfully stored decentralized memory at /kv/${ns}/${key}`;

			if (callback) {
				callback({ text: responseText, action: "TECHNOCORE_KV_SET" });
			}

			return {
				success: true,
				response: responseText,
				data: result,
			};
		} catch (err: any) {
			const errMessage = `Failed to store Technocore KV: ${err.message}`;
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
				content: { text: "Save current agent goals to Technocore KV." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Storing agent goals in decentralized KV store...",
					action: "TECHNOCORE_KV_SET",
				},
			},
		],
	],
};

export const kvGetAction: Action = {
	name: "TECHNOCORE_KV_GET",
	similes: [
		"LOAD_TECHNOCORE_MEMORY",
		"GET_DECENTRALIZED_KV",
		"READ_TECHNOCORE_STATE",
	],
	description: "Retrieves a persistent memory entry from the Technocore decentralized Key-Value store.",
	validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
		const text = message.content?.text || "";
		return /read\s+memory|load\s+from\s+kv|technocore\s+kv\s+get/i.test(text);
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
			const result = await service.kvGet("eliza-agent", "latest");

			const responseText = `Retrieved Technocore KV memory: ${result.value || "None"}`;

			if (callback) {
				callback({ text: responseText, action: "TECHNOCORE_KV_GET" });
			}

			return {
				success: true,
				response: responseText,
				data: result,
			};
		} catch (err: any) {
			const errMessage = `Failed to retrieve Technocore KV: ${err.message}`;
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
				content: { text: "Fetch saved memory from Technocore KV." },
			},
			{
				name: "{{agent}}",
				content: {
					text: "Retrieving memory from decentralized KV store...",
					action: "TECHNOCORE_KV_GET",
				},
			},
		],
	],
};
