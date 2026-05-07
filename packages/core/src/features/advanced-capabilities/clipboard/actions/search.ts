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
		if (isValidSearchInput(__avParams)) {
			return true;
		}
		return hasActionContextOrKeyword(message, state, {
			contexts: ["files", "knowledge", "agent_internal"],
			keywords: [
				"clipboard",
				"search notes",
				"find notes",
				"look for notes",
				"what did i save",
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
