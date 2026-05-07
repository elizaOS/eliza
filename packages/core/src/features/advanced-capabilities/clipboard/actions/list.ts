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
import { createClipboardService } from "../services/clipboardService.ts";
import { requireActionSpec } from "../specs.ts";

const spec = requireActionSpec("CLIPBOARD_LIST");

export const clipboardListAction: Action = {
	name: spec.name,
	contexts: ["files", "knowledge", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,
	parameters: [],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		_options?: HandlerOptions,
	): Promise<boolean> => {
		return hasActionContextOrKeyword(message, state, {
			contexts: ["files", "knowledge", "agent_internal"],
			keywords: ["clipboard", "list notes", "show notes", "saved notes"],
		});
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_stateFromTrigger: State | undefined,
		_options: HandlerOptions | undefined,
		callback?: HandlerCallback,
		_responses?: Memory[],
	) => {
		try {
			const service = createClipboardService(runtime);
			const entries = await service.list();

			if (entries.length === 0) {
				if (callback) {
					await callback({
						text: "You don't have any clipboard entries yet. Use CLIPBOARD_WRITE to create one.",
						actions: ["CLIPBOARD_LIST_EMPTY"],
						source: message.content.source,
					});
				}
				return { success: true, text: "No entries", entries: [] };
			}

			const listText = entries
				.map((e, i) => {
					const tagsStr = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
					return `${i + 1}. **${e.title}** (${e.id})${tagsStr}\n   _Modified: ${e.modifiedAt.toLocaleDateString()}_`;
				})
				.join("\n");

			const successMessage = `**Your Clipboard Entries** (${entries.length} total):\n\n${listText}`;

			if (callback) {
				await callback({
					text: successMessage,
					actions: ["CLIPBOARD_LIST_SUCCESS"],
					source: message.content.source,
				});
			}

			return { success: true, text: successMessage, entries };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("[ClipboardList] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to list clipboard entries: ${errorMsg}`,
					actions: ["CLIPBOARD_LIST_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: "Failed to list clipboard entries" };
		}
	},

	examples: [],
};

export default clipboardListAction;
