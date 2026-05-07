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

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function normalizeTags(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const tags = value
			.map((tag) => (typeof tag === "string" ? tag.trim() : ""))
			.filter(Boolean);
		return tags.length > 0 ? tags : undefined;
	}
	if (typeof value === "string") {
		const tags = value
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean);
		return tags.length > 0 ? tags : undefined;
	}
	return undefined;
}

function extractWriteInfo(
	message: Memory,
	options?: HandlerOptions,
): WriteInput | null {
	const params = readParams(options);
	const raw = {
		title: params.title ?? message.content.title,
		content: params.content ?? message.content.content,
		tags: params.tags ?? message.content.tags,
	};

	if (!isValidWriteInput(raw)) {
		logger.error("[ClipboardWrite] Failed to extract valid write info");
		return null;
	}

	return {
		title: String(raw.title),
		content: String(raw.content),
		tags: normalizeTags(raw.tags),
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
		const __avKeywordOk = __avKeywords.some(
			(kw) => kw.length > 0 && __avText.includes(kw),
		);
		const __avRegex = /\b(?:clipboard|write)\b/i;
		const __avRegexOk = __avRegex.test(__avText);
		const __avSource = String(message?.content?.source ?? "");
		const __avExpectedSource = "";
		const __avSourceOk = __avExpectedSource
			? __avSource === __avExpectedSource
			: Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
		const __avOptions = options && typeof options === "object" ? options : {};
		const __avParams = readParams(options);
		if (isValidWriteInput(__avParams)) {
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
		_stateFromTrigger: State | undefined,
		_options: HandlerOptions | undefined,
		callback?: HandlerCallback,
		_responses?: Memory[],
	) => {
		const writeInfo = extractWriteInfo(message, _options);

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

	parameters: [
		{
			name: "title",
			description: "Short, descriptive title for the clipboard note.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "content",
			description: "Full note content to save to the clipboard.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "tags",
			description: "Optional tags for categorizing the clipboard note.",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const },
			},
		},
	],
	examples: [],
};

export default clipboardWriteAction;
