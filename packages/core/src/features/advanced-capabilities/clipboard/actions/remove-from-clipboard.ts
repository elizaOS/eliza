import {
	type Action,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	logger,
	type Memory,
	type State,
} from "../../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../../utils/action-validation.ts";
import { createTaskClipboardService } from "../services/taskClipboardService.ts";

async function resolveItemId(
	runtime: IAgentRuntime,
	message: Memory,
	options?: HandlerOptions,
): Promise<string | null> {
	const params =
		options?.parameters && typeof options.parameters === "object"
			? (options.parameters as Record<string, unknown>)
			: {};
	if (typeof params.itemId === "string" && params.itemId.trim()) {
		return params.itemId.trim();
	}
	if (
		typeof message.content.itemId === "string" &&
		message.content.itemId.trim()
	) {
		return message.content.itemId.trim();
	}
	if (typeof message.content.id === "string" && message.content.id.trim()) {
		return message.content.id.trim();
	}
	const entityId =
		typeof message.entityId === "string" ? message.entityId : undefined;
	const service = createTaskClipboardService(runtime);
	const items = await service.listItems(entityId);
	if (items.length === 1) {
		return items[0]?.id ?? null;
	}
	const text =
		typeof message.content.text === "string" ? message.content.text : "";
	if (!text.trim() || items.length === 0) {
		return null;
	}
	for (const item of items) {
		if (text.includes(item.id)) {
			return item.id;
		}
	}
	return null;
}

export const removeFromClipboardAction: Action = {
	name: "REMOVE_FROM_CLIPBOARD",
	contexts: ["files", "knowledge", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	similes: ["CLEAR_CLIPBOARD_ITEM", "DELETE_CLIPBOARD_ITEM"],
	description:
		"Remove an item from the bounded clipboard when it is no longer needed for the current task.",
	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const params =
			options &&
			typeof options === "object" &&
			"parameters" in options &&
			options.parameters &&
			typeof options.parameters === "object"
				? (options.parameters as Record<string, unknown>)
				: {};
		const hasStructuredItemId =
			typeof params.itemId === "string" && params.itemId.trim().length > 0;
		const hasContentItemId = typeof message.content.itemId === "string";
		const rawText = String(message.content.text ?? "");
		const safeText =
			rawText.length > 10_000 ? rawText.slice(0, 10_000) : rawText;
		return (
			hasStructuredItemId ||
			hasContentItemId ||
			/(?:remove|clear|drop).*(?:clipboard|saved item)/i.test(safeText) ||
			hasActionContextOrKeyword(message, _state, {
				contexts: ["files", "knowledge", "agent_internal"],
				keywords: [
					"remove clipboard",
					"clear clipboard",
					"drop clipboard",
					"delete clipboard item",
				],
			})
		);
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		_options: HandlerOptions | undefined,
		callback?: HandlerCallback,
	) => {
		try {
			const itemId = await resolveItemId(runtime, message, _options);
			if (!itemId) {
				throw new Error("I couldn't determine which clipboard item to remove.");
			}
			const entityId =
				typeof message.entityId === "string" ? message.entityId : undefined;
			const service = createTaskClipboardService(runtime);
			const { removed, snapshot } = await service.removeItem(itemId, entityId);
			if (!removed) {
				throw new Error(`Clipboard item not found: ${itemId}`);
			}
			const responseText = `Removed clipboard item ${itemId}. Clipboard usage: ${snapshot.items.length}/${snapshot.maxItems}.`;
			if (callback) {
				await callback({
					text: responseText,
					actions: ["REMOVE_FROM_CLIPBOARD_SUCCESS"],
					source: message.content.source,
				});
			}
			return {
				success: true,
				text: responseText,
				data: {
					itemId,
					clipboardCount: snapshot.items.length,
					maxItems: snapshot.maxItems,
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error("[RemoveFromClipboard] Error:", errorMessage);
			if (callback) {
				await callback({
					text: `Failed to remove clipboard item: ${errorMessage}`,
					actions: ["REMOVE_FROM_CLIPBOARD_FAILED"],
					source: message.content.source,
				});
			}
			return {
				success: false,
				text: "Failed to remove clipboard item",
				error: errorMessage,
			};
		}
	},
	parameters: [
		{
			name: "itemId",
			description: "Stable bounded clipboard item ID to remove.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
	],
	examples: [],
};

export default removeFromClipboardAction;
