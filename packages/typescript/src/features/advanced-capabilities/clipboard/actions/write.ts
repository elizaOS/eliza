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

interface WriteInput {
	title: string;
	content: string;
	tags?: string[];
}

function isValidWriteInput(obj: Record<string, unknown>): boolean {
	return (
		typeof obj.title === "string" &&
		obj.title.length > 0 &&
		typeof obj.content === "string" &&
		obj.content.length > 0
	);
}

const EXTRACT_TEMPLATE = `Extract the following information from the user's message to save to the clipboard:

User message: {{text}}

Recent conversation:
{{messageHistory}}

Respond with XML containing:
- title: A short, descriptive title for the note (required)
- content: The main content to save (required)
- tags: Comma-separated tags for categorization (optional)

<response>
<title>The note title</title>
<content>The content to save</content>
<tags>tag1, tag2</tags>
</response>`;

async function extractWriteInfo(
	runtime: IAgentRuntime,
	message: Memory,
	_state: State,
): Promise<WriteInput | null> {
	const prompt = EXTRACT_TEMPLATE.replace(
		"{{text}}",
		message.content.text ?? "",
	).replace("{{messageHistory}}", "");

	const result = await runtime.useModel(ModelType.TEXT_SMALL, {
		prompt,
		stopSequences: [],
	});

	logger.debug("[ClipboardWrite] Extract result:", result);

	const parsed = parseKeyValueXml(String(result)) as Record<
		string,
		unknown
	> | null;

	if (!parsed || !isValidWriteInput(parsed)) {
		logger.error("[ClipboardWrite] Failed to extract valid write info");
		return null;
	}

	const tags = parsed.tags
		? String(parsed.tags)
				.split(",")
				.map((t: string) => t.trim())
				.filter(Boolean)
		: undefined;

	return {
		title: String(parsed.title),
		content: String(parsed.content),
		tags,
	};
}

const spec = requireActionSpec("CLIPBOARD_WRITE");

export const clipboardWriteAction: Action = {
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
		const __avKeywords = ["clipboard", "write"];
		const __avKeywordOk =
			__avKeywords.length > 0 &&
			__avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
		const __avRegex = /\b(?:clipboard|write)\b/i;
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
			message: Memory,
		): Promise<boolean> => {
			// Check for clipboard-related intent in the message
			const text = (message.content?.text ?? "").toLowerCase();
			const hasSaveIntent =
				text.includes("save") ||
				text.includes("note") ||
				text.includes("remember") ||
				text.includes("write") ||
				text.includes("clipboard") ||
				text.includes("jot down") ||
				text.includes("store");

			return hasSaveIntent;
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
		stateFromTrigger: State | undefined,
		_options: HandlerOptions | undefined,
		callback?: HandlerCallback,
		_responses?: Memory[],
	) => {
		const state = stateFromTrigger ?? (await runtime.composeState(message, []));
		const writeInfo = await extractWriteInfo(runtime, message, state);

		if (!writeInfo) {
			if (callback) {
				await callback({
					text: "I couldn't understand what you want me to save. Please provide a clear title and content for the note.",
					actions: ["CLIPBOARD_WRITE_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: "Failed to extract write info" };
		}

		try {
			const service = createClipboardService(runtime);
			const entry = await service.write(writeInfo.title, writeInfo.content, {
				tags: writeInfo.tags,
			});

			const successMessage = `I've saved a note titled "${entry.title}" (ID: ${entry.id}).${
				entry.tags?.length ? ` Tags: ${entry.tags.join(", ")}` : ""
			} You can retrieve it later using the ID or by searching for it.`;

			if (callback) {
				await callback({
					text: successMessage,
					actions: ["CLIPBOARD_WRITE_SUCCESS"],
					source: message.content.source,
				});
			}

			return { success: true, text: successMessage, entryId: entry.id };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("[ClipboardWrite] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to save the note: ${errorMsg}`,
					actions: ["CLIPBOARD_WRITE_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: "Failed to write to clipboard" };
		}
	},

	examples: [],
};

export default clipboardWriteAction;
