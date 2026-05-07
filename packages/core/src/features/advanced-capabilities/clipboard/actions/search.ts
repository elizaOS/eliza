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

interface SearchInput {
	query: string;
	maxResults?: number;
}

function isValidSearchInput(obj: Record<string, unknown>): boolean {
	return typeof obj.query === "string" && obj.query.length > 0;
}

function readParams(options?: HandlerOptions): Record<string, unknown> {
	return options?.parameters && typeof options.parameters === "object"
		? (options.parameters as Record<string, unknown>)
		: {};
}

function optionalNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function extractSearchInfo(
	message: Memory,
	options?: HandlerOptions,
): SearchInput | null {
	const params = readParams(options);
	const raw = {
		query: params.query ?? message.content.query,
		maxResults: params.maxResults ?? message.content.maxResults,
	};

	if (!isValidSearchInput(raw)) {
		logger.error("[ClipboardSearch] Failed to extract valid search info");
		return null;
	}

	return {
		query: String(raw.query),
		maxResults: optionalNumber(raw.maxResults) ?? 5,
	};
}

const spec = requireActionSpec("CLIPBOARD_SEARCH");

export const clipboardSearchAction: Action = {
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
		const __avKeywords = ["clipboard", "search"];
		const __avKeywordOk = __avKeywords.some(
			(kw) => kw.length > 0 && __avText.includes(kw),
		);
		const __avRegex = /\b(?:clipboard|search)\b/i;
		const __avRegexOk = __avRegex.test(__avText);
		const __avSource = String(message?.content?.source ?? "");
		const __avExpectedSource = "";
		const __avSourceOk = __avExpectedSource
			? __avSource === __avExpectedSource
			: Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
		const __avOptions = options && typeof options === "object" ? options : {};
		const __avParams = readParams(options);
		if (isValidSearchInput(__avParams)) {
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
			// Check for search/retrieval intent in the message
			const text = (message.content?.text ?? "").toLowerCase();
			const hasSearchIntent =
				text.includes("search") ||
				text.includes("find") ||
				text.includes("look for") ||
				text.includes("clipboard") ||
				text.includes("notes") ||
				text.includes("retrieve") ||
				text.includes("lookup") ||
				text.includes("what did i save");

			return hasSearchIntent;
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
		const searchInfo = extractSearchInfo(message, _options);

		if (!searchInfo) {
			if (callback) {
				await callback({
					text: "I couldn't understand what you're searching for. Please provide search terms.",
					actions: ["CLIPBOARD_SEARCH_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: "Failed to extract search info" };
		}

		try {
			const service = createClipboardService(runtime);
			const results = await service.search(searchInfo.query, {
				maxResults: searchInfo.maxResults,
			});

			if (results.length === 0) {
				if (callback) {
					await callback({
						text: `No clipboard entries found matching "${searchInfo.query}".`,
						actions: ["CLIPBOARD_SEARCH_EMPTY"],
						source: message.content.source,
					});
				}
				return { success: true, text: "No results found", results: [] };
			}

			const resultText = results
				.map((r, i) => {
					const scorePercent = Math.round(r.score * 100);
					return `**${i + 1}. ${r.entryId}** (${scorePercent}% match, lines ${r.startLine}-${r.endLine})\n\`\`\`\n${r.snippet.substring(0, 200)}${r.snippet.length > 200 ? "..." : ""}\n\`\`\``;
				})
				.join("\n\n");

			const successMessage = `Found ${results.length} matching clipboard entries for "${searchInfo.query}":\n\n${resultText}\n\nUse CLIPBOARD_READ with an entry ID to view the full content.`;

			if (callback) {
				await callback({
					text: successMessage,
					actions: ["CLIPBOARD_SEARCH_SUCCESS"],
					source: message.content.source,
				});
			}

			return { success: true, text: successMessage, results };
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			logger.error("[ClipboardSearch] Error:", errorMsg);
			if (callback) {
				await callback({
					text: `Failed to search clipboard: ${errorMsg}`,
					actions: ["CLIPBOARD_SEARCH_FAILED"],
					source: message.content.source,
				});
			}
			return { success: false, text: "Failed to search clipboard" };
		}
	},

	parameters: [
		{
			name: "query",
			description: "Search terms to find in clipboard entries.",
			required: true,
			schema: { type: "string" as const, minLength: 1 },
		},
		{
			name: "maxResults",
			description: "Maximum number of matching snippets to return.",
			required: false,
			schema: { type: "number" as const, minimum: 1, maximum: 20, default: 5 },
		},
	],
	examples: [],
};

export default clipboardSearchAction;
