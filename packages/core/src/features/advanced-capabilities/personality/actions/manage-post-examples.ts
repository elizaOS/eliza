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

type PostAction = "add" | "remove" | "edit";

type ManagePostExamplesParameters = {
	action?: string;
	index?: unknown;
	text?: string;
};

function isPostAction(value: unknown): value is PostAction {
	return value === "add" || value === "remove" || value === "edit";
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
 * Add, remove, or edit a single entry in the agent's
 * `character.postExamples` array (a flat string array of sample posts).
 *
 * Persists through the standard `eliza_character_persistence` service.
 */
export const managePostExamplesAction: Action = {
	name: "MANAGE_POST_EXAMPLES",
	contexts: ["settings", "social_posting", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	similes: [
		"UPDATE_POST_EXAMPLES",
		"EDIT_POST_EXAMPLES",
		"ADD_POST_EXAMPLE",
		"REMOVE_POST_EXAMPLE",
		"EDIT_POST_EXAMPLE",
	],
	description:
		"Adds, removes, or edits a single entry in character.postExamples. Use this when the user wants to manage specific sample posts the agent should mimic for social-media-style outputs.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "action",
			description:
				"Operation: 'add' inserts a new post (at 'index' if provided, otherwise appended); 'remove' deletes the post at 'index'; 'edit' replaces the post at 'index'.",
			required: true,
			schema: {
				type: "string" as const,
				enum: ["add", "remove", "edit"],
			},
		},
		{
			name: "index",
			description:
				"0-based index for the operation. Required for 'remove' and 'edit'; optional for 'add' (defaults to appending).",
			required: false,
			schema: { type: "number" as const },
		},
		{
			name: "text",
			description:
				"Required for 'add' and 'edit': the post body text to insert or replace.",
			required: false,
			schema: { type: "string" as const },
		},
	],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> =>
		hasActionContextOrKeyword(message, state, {
			contexts: ["settings", "social_posting", "agent_internal"],
			keywords: [
				"post examples",
				"sample posts",
				"social examples",
				"add post example",
				"edit post example",
				"remove post example",
			],
		}),

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ?? {}) as ManagePostExamplesParameters;
		const postAction = params.action?.trim();
		const index = normalizeIndex(params.index);
		const text = typeof params.text === "string" ? params.text.trim() : "";

		if (!isPostAction(postAction)) {
			const errMsg =
				"I need a valid action ('add', 'remove', or 'edit') to update post examples.";
			await callback?.({ text: errMsg, thought: "Invalid post action" });
			return {
				text: errMsg,
				success: false,
				values: { error: "invalid_action" },
				data: { action: "MANAGE_POST_EXAMPLES" },
			};
		}

		try {
			const current = [...(runtime.character.postExamples ?? [])];
			let next: string[] = current;
			let summary = "";

			if (postAction === "add") {
				if (!text) {
					const errMsg = "I need 'text' to add a new post example.";
					await callback?.({ text: errMsg, thought: "Missing text for add" });
					return {
						text: errMsg,
						success: false,
						values: { error: "missing_text" },
						data: { action: "MANAGE_POST_EXAMPLES" },
					};
				}
				if (index !== undefined && index <= current.length) {
					next = [...current.slice(0, index), text, ...current.slice(index)];
					summary = `Inserted post example at index ${index}.`;
				} else {
					next = [...current, text];
					summary = `Appended post example at index ${current.length}.`;
				}
			} else if (postAction === "remove") {
				if (index === undefined || index >= current.length) {
					const errMsg =
						"I need a valid in-range index to remove a post example.";
					await callback?.({
						text: errMsg,
						thought: "Invalid remove index",
					});
					return {
						text: errMsg,
						success: false,
						values: { error: "invalid_index" },
						data: { action: "MANAGE_POST_EXAMPLES" },
					};
				}
				next = [...current.slice(0, index), ...current.slice(index + 1)];
				summary = `Removed post example at index ${index}.`;
			} else {
				// edit
				if (index === undefined || index >= current.length) {
					const errMsg =
						"I need a valid in-range index to edit a post example.";
					await callback?.({
						text: errMsg,
						thought: "Invalid edit index",
					});
					return {
						text: errMsg,
						success: false,
						values: { error: "invalid_index" },
						data: { action: "MANAGE_POST_EXAMPLES" },
					};
				}
				if (!text) {
					const errMsg = "I need 'text' to edit a post example.";
					await callback?.({
						text: errMsg,
						thought: "Missing text for edit",
					});
					return {
						text: errMsg,
						success: false,
						values: { error: "missing_text" },
						data: { action: "MANAGE_POST_EXAMPLES" },
					};
				}
				next = [...current];
				next[index] = text;
				summary = `Edited post example at index ${index}.`;
			}

			const result = await persistCharacterPatch(runtime, {
				postExamples: next,
			});

			if (!result.success) {
				const errMsg = `I couldn't save the post example change: ${result.error ?? "unknown error"}`;
				await callback?.({
					text: errMsg,
					thought: "Post example persistence failed",
				});
				return {
					text: errMsg,
					success: false,
					values: { error: result.error ?? "persistence_failed" },
					data: { action: "MANAGE_POST_EXAMPLES" },
				};
			}

			await callback?.({
				text: summary,
				thought: `Applied post example change: action=${postAction}; index=${index ?? "none"}`,
				actions: ["MANAGE_POST_EXAMPLES"],
			});

			return {
				text: summary,
				success: true,
				values: {
					action: postAction,
					index: index ?? null,
					totalPostExamples: next.length,
				},
				data: {
					action: "MANAGE_POST_EXAMPLES",
					postChange: {
						operation: postAction,
						index: index ?? null,
					},
				},
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in MANAGE_POST_EXAMPLES action",
			);
			const errMsg = "I encountered an error while updating post examples.";
			await callback?.({
				text: errMsg,
				thought: `Error in manage post examples: ${(error as Error).message}`,
			});
			return {
				text: errMsg,
				success: false,
				values: { error: (error as Error).message },
				data: {
					action: "MANAGE_POST_EXAMPLES",
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
					text: "Add a post example: 'Just shipped a new feature, more details soon.'",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Appended post example at index 0.",
					actions: ["MANAGE_POST_EXAMPLES"],
				},
			},
		],
		[
			{
				name: "{{user}}",
				content: {
					text: "Remove the post example at index 2.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Removed post example at index 2.",
					actions: ["MANAGE_POST_EXAMPLES"],
				},
			},
		],
	] as ActionExample[][],
};
