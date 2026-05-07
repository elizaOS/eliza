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

interface AppendInput {
	id: string;
	content: string;
}

function isValidAppendInput(obj: Record<string, unknown>): boolean {
	return (
		typeof obj.id === "string" &&
		obj.id.length > 0 &&
		typeof obj.content === "string" &&
		obj.content.length > 0
	);
}

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function extractAppendInfo(
	message: Memory,
	options?: HandlerOptions,
): AppendInput | null {
	const params = readParams(options);
	const raw = {
		id: params.id ?? message.content.id ?? message.content.entryId,
		content: params.content ?? message.content.content,
	};

	if (!isValidAppendInput(raw)) {
		logger.error("[ClipboardAppend] Failed to extract valid append info");
		return null;
	}

	return {
		id: String(raw.id),
		content: String(raw.content),
	};
}

const spec = requireActionSpec("CLIPBOARD_APPEND");

export const clipboardAppendAction: Action = {
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
		const __avKeywords = ["clipboard", "append"];
		const __avKeywordOk = __avKeywords.some(
			(kw) => kw.length > 0 && __avText.includes(kw),
		);
		const __avRegex = /\b(?:clipboard|append)\b/i;
		const __avRegexOk = __avRegex.test(__avText);
		const __avSource = String(message?.content?.source ?? "");
		const __avExpectedSource = "";
		const __avSourceOk = __avExpectedSource
			? __avSource === __avExpectedSource
			: Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
		const __avOptions = options && typeof options === "object" ? options : {};
		const __avParams = readParams(options);
		if (isValidAppendInput(__avParams)) {
			return true;
		}
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
					text: "There are no clipboard entries to append to. Create one first with CLIPBOARD_WRITE.",
					actions: ["CLIPBOARD_APPEND_EMPTY"],
					source: message.content.source,
				});
			}
			return { success: false, text: "No entries available" };
		}

		const appendInfo = extractAppendInfo(message, _options);

		if (!appendInfo) {
			if (callback) {
				await callback({
					text: `I couldn't determine which note to update or what to add. Available entries:\n${entriesContext}`,
					actions: ["CLIPBOARD_APPEND_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: "Failed to extract append info" };
		}

		try {
			// Check if entry exists
			const exists = await service.exists(appendInfo.id);
			if (!exists) {
				if (callback) {
					await callback({
						text: `Clipboard entry "${appendInfo.id}" not found. Available entries:\n${entriesContext}`,
						actions: ["CLIPBOARD_APPEND_NOT_FOUND"],
						source: message.content.source,
					});
				}
				return { success: false, text: "Entry not found" };
			}

			// Get existing entry to preserve title
			const existingEntry = await service.read(appendInfo.id);

			// Write with append option
			const entry = await service.write(
				existingEntry.title,
				appendInfo.content,
				{
					append: true,
					tags: existingEntry.tags,
				},
			);

			const successMessage = `Successfully appended content to "${entry.title}" (${entry.id}).`;

			if (callback) {
				await callback({
					text: successMessage,
					actions: ["CLIPBOARD_APPEND_SUCCESS"],
					source: message.content.source,
				});
			}

			return { success: true, text: successMessage, entry };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("[ClipboardAppend] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to append to the note: ${errorMsg}`,
					actions: ["CLIPBOARD_APPEND_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: "Failed to append to clipboard entry" };
		}
	},

	parameters: [
		{
			name: "id",
			description: "Clipboard entry ID to append content to.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "content",
			description: "Content to append to the clipboard entry.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
	],
	examples: [],
};

export default clipboardAppendAction;
