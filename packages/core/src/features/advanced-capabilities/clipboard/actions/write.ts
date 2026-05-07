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
const MAX_TITLE_CHARS = 120;
const MAX_TAGS = 12;
const MAX_TAG_CHARS = 48;

function truncateText(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export const clipboardWriteAction: Action = {
	name: spec.name,
	contexts: ["files", "knowledge", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	similes: spec.similes ? [...spec.similes] : [],
	description: spec.description,

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
		options?: HandlerOptions,
	): Promise<boolean> => {
		const __avParams = readParams(options);
		if (isValidWriteInput(__avParams)) {
			return true;
		}
		return hasActionContextOrKeyword(message, state, {
			contexts: ["files", "knowledge", "agent_internal"],
			keywords: [
				"clipboard",
				"write note",
				"save note",
				"jot down",
				"store note",
				"remember this",
			],
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
			const entry = await service.write(
				truncateText(writeInfo.title, MAX_TITLE_CHARS),
				writeInfo.content,
				{
					tags: writeInfo.tags
						?.slice(0, MAX_TAGS)
						.map((tag) => truncateText(tag, MAX_TAG_CHARS)),
				},
			);

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

			return {
				success: true,
				text: successMessage,
				data: { entryId: entry.id, title: entry.title },
			};
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
