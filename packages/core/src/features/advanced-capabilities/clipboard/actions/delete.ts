import {
	type Action,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	logger,
	type Memory,
	ModelType,
	parseKeyValueXml,
	type State,
} from "../../../../types/index.ts";
import { createClipboardService } from "../services/clipboardService.ts";
import { requireActionSpec } from "../specs.ts";

interface DeleteInput {
	id: string;
}

function isValidDeleteInput(obj: Record<string, unknown>): boolean {
	return typeof obj.id === "string" && obj.id.length > 0;
}

const EXTRACT_TEMPLATE = `Extract the clipboard entry ID to delete from the user's message.

User message: {{text}}

Available clipboard entries:
{{entries}}

Respond with XML containing:
- id: The ID of the clipboard entry to delete (required)

<response>
<id>entry-id</id>
</response>`;

async function extractDeleteInfo(
	runtime: IAgentRuntime,
	message: Memory,
	availableEntries: string,
): Promise<DeleteInput | null> {
	const prompt = EXTRACT_TEMPLATE.replace(
		"{{text}}",
		message.content.text ?? "",
	).replace("{{entries}}", availableEntries);

	const result = await runtime.useModel(ModelType.TEXT_SMALL, {
		prompt,
		stopSequences: [],
	});

	logger.debug("[ClipboardDelete] Extract result:", result);

	const parsed = parseKeyValueXml(String(result)) as Record<
		string,
		unknown
	> | null;

	if (!parsed || !isValidDeleteInput(parsed)) {
		logger.error("[ClipboardDelete] Failed to extract valid delete info");
		return null;
	}

	return {
		id: String(parsed.id),
	};
}

const spec = requireActionSpec("CLIPBOARD_DELETE");

export const clipboardDeleteAction: Action = {
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
		const __avKeywords = ["clipboard", "delete"];
		const __avKeywordOk =
			__avKeywords.length > 0 &&
			__avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
		const __avRegex = /\b(?:clipboard|delete)\b/i;
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
		const service = createClipboardService(runtime);

		// Get list of available entries for context
		const entries = await service.list();
		const entriesContext = entries
			.map((e) => `- ${e.id}: "${e.title}"`)
			.join("\n");

		if (entries.length === 0) {
			if (callback) {
				await callback({
					text: "There are no clipboard entries to delete.",
					actions: ["CLIPBOARD_DELETE_EMPTY"],
					source: message.content.source,
				});
			}
			return { success: false, text: "No entries available" };
		}

		const deleteInfo = await extractDeleteInfo(
			runtime,
			message,
			entriesContext,
		);

		if (!deleteInfo) {
			if (callback) {
				await callback({
					text: `I couldn't determine which note to delete. Available entries:\n${entriesContext}`,
					actions: ["CLIPBOARD_DELETE_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: "Failed to extract delete info" };
		}

		try {
			const deleted = await service.delete(deleteInfo.id);

			if (!deleted) {
				if (callback) {
					await callback({
						text: `Clipboard entry "${deleteInfo.id}" not found.`,
						actions: ["CLIPBOARD_DELETE_NOT_FOUND"],
						source: message.content.source,
					});
				}
				return { success: false, text: "Entry not found" };
			}

			const successMessage = `Successfully deleted clipboard entry "${deleteInfo.id}".`;

			if (callback) {
				await callback({
					text: successMessage,
					actions: ["CLIPBOARD_DELETE_SUCCESS"],
					source: message.content.source,
				});
			}

			return { success: true, text: successMessage };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("[ClipboardDelete] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to delete the note: ${errorMsg}`,
					actions: ["CLIPBOARD_DELETE_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: "Failed to delete clipboard entry" };
		}
	},

	examples: [],
};

export default clipboardDeleteAction;
