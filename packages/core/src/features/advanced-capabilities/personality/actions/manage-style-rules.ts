import { logger } from "../../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../../utils/action-validation.ts";
import { persistCharacterPatch } from "./shared/persist-character-patch.ts";

type StyleAction = "add" | "remove" | "reorder";
type StyleCategory = "all" | "chat" | "post";

type ManageStyleRulesParameters = {
	action?: string;
	category?: string;
	items?: unknown;
	index?: unknown;
};

function isStyleAction(value: unknown): value is StyleAction {
	return value === "add" || value === "remove" || value === "reorder";
}

function isStyleCategory(value: unknown): value is StyleCategory {
	return value === "all" || value === "chat" || value === "post";
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((entry): entry is string => typeof entry === "string")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
}

function normalizeIndex(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
		return value;
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isInteger(parsed) && parsed >= 0) return parsed;
	}
	return undefined;
}

/**
 * Mutate the agent's `character.style[category]` array (add, remove,
 * or reorder entries). Persists through the standard
 * `eliza_character_persistence` service used by `MODIFY_CHARACTER`.
 */
export const manageStyleRulesAction: Action = {
	name: "MANAGE_STYLE_RULES",
	contexts: ["settings", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	similes: [
		"UPDATE_STYLE_RULES",
		"EDIT_STYLE_RULES",
		"ADD_STYLE_RULE",
		"REMOVE_STYLE_RULE",
		"REORDER_STYLE_RULES",
	],
	description:
		"Adds, removes, or reorders entries in the agent's character.style[category] arrays (all/chat/post). Use this when the user wants to modify specific style guidelines without rewriting the whole personality.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "action",
			description:
				"Operation to perform on the style array. 'add' appends items (or inserts at 'index' when provided). 'remove' deletes entries listed in items (or the entry at 'index'). 'reorder' moves the entry at 'index' to a new position equal to items[0] interpreted as the destination index.",
			required: true,
			schema: {
				type: "string" as const,
				enum: ["add", "remove", "reorder"],
			},
		},
		{
			name: "category",
			description:
				"Which style bucket to modify: 'all' applies everywhere, 'chat' to chat replies, 'post' to social posts.",
			required: true,
			schema: {
				type: "string" as const,
				enum: ["all", "chat", "post"],
			},
		},
		{
			name: "items",
			description:
				"For 'add': style strings to insert. For 'remove': exact strings to delete (case-insensitive). For 'reorder': a single-element array whose entry is the new destination index, e.g. [2].",
			required: false,
			schema: {
				type: "array" as const,
				items: { type: "string" as const },
			},
		},
		{
			name: "index",
			description:
				"Optional 0-based index. For 'add' it specifies the insertion position; for 'remove' it deletes the entry at that index when items is empty; for 'reorder' it is the source index.",
			required: false,
			schema: { type: "number" as const },
		},
	],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> =>
		hasActionContextOrKeyword(message, state, {
			contexts: ["settings", "agent_internal"],
			keywords: [
				"style rules",
				"style guideline",
				"tone rules",
				"chat style",
				"post style",
				"add style",
				"remove style",
				"reorder style",
			],
		}),

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ?? {}) as ManageStyleRulesParameters;
		const styleAction = params.action?.trim();
		const category = params.category?.trim();
		const items = normalizeStringArray(params.items);
		const index = normalizeIndex(params.index);

		if (!isStyleAction(styleAction)) {
			const text =
				"I need a valid action ('add', 'remove', or 'reorder') to update style rules.";
			await callback?.({ text, thought: "Invalid style action" });
			return {
				text,
				success: false,
				values: { error: "invalid_action" },
				data: { action: "MANAGE_STYLE_RULES" },
			};
		}

		if (!isStyleCategory(category)) {
			const text =
				"I need a valid style category ('all', 'chat', or 'post') to update style rules.";
			await callback?.({ text, thought: "Invalid style category" });
			return {
				text,
				success: false,
				values: { error: "invalid_category" },
				data: { action: "MANAGE_STYLE_RULES" },
			};
		}

		try {
			const currentStyle = (runtime.character.style ?? {}) as {
				all?: string[];
				chat?: string[];
				post?: string[];
			};
			const currentList = [...(currentStyle[category] ?? [])];
			let nextList: string[] = currentList;
			let summary = "";

			if (styleAction === "add") {
				if (items.length === 0) {
					const text = "I need at least one style string to add.";
					await callback?.({ text, thought: "No items to add" });
					return {
						text,
						success: false,
						values: { error: "missing_items" },
						data: { action: "MANAGE_STYLE_RULES" },
					};
				}
				if (index !== undefined && index <= currentList.length) {
					nextList = [
						...currentList.slice(0, index),
						...items,
						...currentList.slice(index),
					];
				} else {
					nextList = [...currentList, ...items];
				}
				summary = `Added ${items.length} style rule(s) to '${category}'.`;
			} else if (styleAction === "remove") {
				if (items.length === 0 && index === undefined) {
					const text =
						"I need either an items list or an index to remove style rules.";
					await callback?.({ text, thought: "No remove target provided" });
					return {
						text,
						success: false,
						values: { error: "missing_remove_target" },
						data: { action: "MANAGE_STYLE_RULES" },
					};
				}
				if (items.length > 0) {
					const lowered = new Set(items.map((value) => value.toLowerCase()));
					nextList = currentList.filter(
						(entry) => !lowered.has(entry.toLowerCase()),
					);
				} else if (index !== undefined && index < currentList.length) {
					nextList = [
						...currentList.slice(0, index),
						...currentList.slice(index + 1),
					];
				}
				const removedCount = currentList.length - nextList.length;
				summary = `Removed ${removedCount} style rule(s) from '${category}'.`;
			} else {
				// reorder
				if (index === undefined || items.length === 0) {
					const text =
						"To reorder I need a source index and a destination index passed as items[0].";
					await callback?.({
						text,
						thought: "Missing reorder source/destination",
					});
					return {
						text,
						success: false,
						values: { error: "missing_reorder_args" },
						data: { action: "MANAGE_STYLE_RULES" },
					};
				}
				const destination = Number.parseInt(items[0], 10);
				if (
					!Number.isInteger(destination) ||
					destination < 0 ||
					destination >= currentList.length ||
					index >= currentList.length
				) {
					const text = "Reorder indices are out of range.";
					await callback?.({ text, thought: "Reorder indices invalid" });
					return {
						text,
						success: false,
						values: { error: "invalid_reorder_indices" },
						data: { action: "MANAGE_STYLE_RULES" },
					};
				}
				const moved = currentList[index];
				const without = [
					...currentList.slice(0, index),
					...currentList.slice(index + 1),
				];
				nextList = [
					...without.slice(0, destination),
					moved,
					...without.slice(destination),
				];
				summary = `Reordered style rule from index ${index} to ${destination} in '${category}'.`;
			}

			const nextStyle = {
				...currentStyle,
				[category]: nextList,
			} as typeof runtime.character.style;
			const result = await persistCharacterPatch(runtime, {
				style: nextStyle,
			});

			if (!result.success) {
				const text = `I couldn't save the style change: ${result.error ?? "unknown error"}`;
				await callback?.({ text, thought: "Style persistence failed" });
				return {
					text,
					success: false,
					values: { error: result.error ?? "persistence_failed" },
					data: { action: "MANAGE_STYLE_RULES" },
				};
			}

			await callback?.({
				text: summary,
				thought: `Applied style change: action=${styleAction}; category=${category}; items=${items.join(", ")}; index=${index ?? "none"}`,
				actions: ["MANAGE_STYLE_RULES"],
			});

			return {
				text: summary,
				success: true,
				values: {
					action: styleAction,
					category,
					nextLength: nextList.length,
				},
				data: {
					action: "MANAGE_STYLE_RULES",
					styleChange: {
						operation: styleAction,
						category,
						items,
						index: index ?? null,
					},
				},
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in MANAGE_STYLE_RULES action",
			);
			const text = "I encountered an error while updating style rules.";
			await callback?.({
				text,
				thought: `Error in manage style rules: ${(error as Error).message}`,
			});
			return {
				text,
				success: false,
				values: { error: (error as Error).message },
				data: {
					action: "MANAGE_STYLE_RULES",
					errorDetails: (error as Error).stack,
				},
			};
		}
	},

	examples: [
		[
			{
				name: "{{user}}",
				content: {
					text: "Add a chat style rule that says 'never use exclamation marks'.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Added 1 style rule(s) to 'chat'.",
					actions: ["MANAGE_STYLE_RULES"],
				},
			},
		],
		[
			{
				name: "{{user}}",
				content: {
					text: "Remove the style rule 'be terse' from the all category.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Removed 1 style rule(s) from 'all'.",
					actions: ["MANAGE_STYLE_RULES"],
				},
			},
		],
	] as ActionExample[][],
};
