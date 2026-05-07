import type {
	IAgentRuntime,
	Memory,
	Provider,
	ProviderResult,
	State,
} from "../../../../types/index.ts";
import { logger } from "../../../../types/index.ts";
import { createTaskClipboardService } from "../services/taskClipboardService.ts";

function previewContent(content: string): string {
	return content.replace(/\s+/g, " ").trim().slice(0, 140);
}

export const clipboardProvider: Provider = {
	name: "clipboard",
	description:
		"Bounded task clipboard state. Each item has a stable ID and stays available in context until removed.",
	dynamic: true,
	contexts: ["media", "messaging"],
	contextGate: { anyOf: ["media", "messaging"] },
	cacheStable: false,
	cacheScope: "turn",
	roleGate: { minRole: "USER" },

	get: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state: State,
	): Promise<ProviderResult> => {
		try {
			const entityId =
				typeof _message.entityId === "string" ? _message.entityId : undefined;
			const service = createTaskClipboardService(runtime);
			const snapshot = await service.getSnapshot(entityId);
			const count = snapshot.items.length;

			const lines = [`Clipboard usage: ${count}/${snapshot.maxItems}.`];
			if (count > 0) {
				lines.push("Clear unused clipboard state when it is no longer needed.");

				// Removal pressure when near capacity
				if (count >= snapshot.maxItems - 1) {
					const oldest = snapshot.items[snapshot.items.length - 1];
					lines.push(
						`WARNING: Clipboard is ${count >= snapshot.maxItems ? "FULL" : "nearly full"}. ` +
							`Remove the least relevant item before adding new content. ` +
							`Least recently updated: ${oldest.id} ("${oldest.title.slice(0, 40)}"). ` +
							`Use REMOVE_FROM_CLIPBOARD to free a slot.`,
					);
				}

				lines.push("");
				for (const item of snapshot.items) {
					lines.push(`- ${item.id}: ${item.title}`);
					lines.push(
						`  source=${item.sourceType}${item.sourceId ? ` (${item.sourceId})` : ""}`,
					);
					lines.push(`  ${previewContent(item.content)}`);
				}
			} else {
				lines.push("No clipboard items are currently stored.");
			}

			return {
				text: lines.join("\n"),
				data: {
					items: snapshot.items,
					count,
					maxItems: snapshot.maxItems,
				},
				values: {
					clipboardCount: count,
					clipboardUsage: `${count}/${snapshot.maxItems}`,
					clipboardItemIds: snapshot.items.map((item) => item.id).join(", "),
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error("[ClipboardProvider] Error:", errorMessage);
			return {
				text: "Clipboard usage: unavailable.",
				data: { items: [], count: 0, error: errorMessage },
				values: { clipboardCount: 0, clipboardUsage: "0/10" },
			};
		}
	},
};

export default clipboardProvider;
