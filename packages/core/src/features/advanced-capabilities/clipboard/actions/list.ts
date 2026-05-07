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
const MAX_LIST_ENTRIES = 20;
const MAX_TITLE_CHARS = 120;
const MAX_TAGS = 8;

function truncateText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

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

			const visibleEntries = entries.slice(0, MAX_LIST_ENTRIES);
			const omittedCount = Math.max(0, entries.length - visibleEntries.length);
			const listText = entries
				.slice(0, MAX_LIST_ENTRIES)
				.map((e, i) => {
					const tags = (e.tags ?? [])
						.slice(0, MAX_TAGS)
						.map((tag) => truncateText(tag, 32));
					const tagsStr = tags.length ? ` [${tags.join(", ")}]` : "";
					return `${i + 1}. **${truncateText(e.title, MAX_TITLE_CHARS)}** (${e.id})${tagsStr}\n   _Modified: ${e.modifiedAt.toLocaleDateString()}_`;
				})
				.join("\n");

			const omittedText =
				omittedCount > 0
					? `\n\n_${omittedCount} more entr${omittedCount === 1 ? "y" : "ies"} omitted._`
					: "";
			const successMessage = `**Your Clipboard Entries** (${entries.length} total):\n\n${listText}${omittedText}`;

			if (callback) {
				await callback({
					text: successMessage,
					actions: ["CLIPBOARD_LIST_SUCCESS"],
					source: message.content.source,
				});
			}

			return {
				success: true,
				text: successMessage,
				data: {
					count: entries.length,
					omittedCount,
					entries: visibleEntries.map((entry) => ({
						id: entry.id,
						title: truncateText(entry.title, MAX_TITLE_CHARS),
						tags: (entry.tags ?? []).slice(0, MAX_TAGS),
						modifiedAt: entry.modifiedAt,
					})),
				},
			};
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
