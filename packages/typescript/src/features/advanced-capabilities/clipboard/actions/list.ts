import {
	type Action,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	logger,
	type Memory,
	type State,
} from "../../../../types/index.ts";
import { createClipboardService } from "../services/clipboardService.ts";
import { requireActionSpec } from "../specs.ts";

const spec = requireActionSpec("CLIPBOARD_LIST");

export const clipboardListAction: Action = {
	name: spec.name,
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const __avTextRaw =
			typeof message?.content?.text === "string" ? message.content.text : "";
		const __avText = __avTextRaw.toLowerCase();
		const __avKeywords = ["clipboard", "list"];
		const __avKeywordOk =
			__avKeywords.length > 0 &&
			__avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
		const __avRegex = /\b(?:clipboard|list)\b/i;
		const __avRegexOk = __avRegex.test(__avText);
		const __avSource = String(message?.content?.source ?? "");
		const __avExpectedSource = "";
		const __avSourceOk = __avExpectedSource
			? __avSource === __avExpectedSource
			: Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
		const __avOptions = options && typeof options === "object" ? options : {};
		const __avInputOk =
			__avText.trim().length > 0 ||
			Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
			Boolean(message?.content && typeof message.content === "object");

		if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
			return false;
		}

		const __avLegacyValidate = async (
			_runtime: IAgentRuntime,
			_message: Memory,
		): Promise<boolean> => {
			return true;
		};
		try {
			return Boolean(await __avLegacyValidate(runtime, message));
		} catch {
			return false;
		}
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
