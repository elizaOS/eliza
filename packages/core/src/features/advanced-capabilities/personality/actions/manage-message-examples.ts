import { logger } from "../../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	IAgentRuntime,
	Memory,
	MessageExample,
	MessageExampleGroup,
	State,
} from "../../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../../utils/action-validation.ts";
import { persistCharacterPatch } from "./shared/persist-character-patch.ts";

type ExampleAction = "add" | "remove" | "edit";
type ExampleRole = "user" | "agent";

type ManageMessageExamplesParameters = {
	action?: string;
	conversationIndex?: unknown;
	turnIndex?: unknown;
	content?: {
		role?: string;
		text?: string;
	};
};

function isExampleAction(value: unknown): value is ExampleAction {
	return value === "add" || value === "remove" || value === "edit";
}

function isExampleRole(value: unknown): value is ExampleRole {
	return value === "user" || value === "agent";
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

function resolveExampleSpeaker(
	runtime: IAgentRuntime,
	role: ExampleRole,
): string {
	if (role === "agent") {
		return runtime.character.name?.trim() || "{{agent}}";
	}
	return "{{user}}";
}

/**
 * Add, remove, or edit individual entries inside the agent's
 * `character.messageExamples` array (an array of conversation groups,
 * each containing an `examples` array of `{ name, content: { text } }`).
 *
 * 'add' appends a new turn (or creates a new group when turnIndex is omitted
 * and conversationIndex is at the end).
 * 'remove' deletes the entire conversation when turnIndex is omitted, or a
 * single turn when turnIndex is provided.
 * 'edit' replaces the content of the turn at conversationIndex/turnIndex.
 *
 * Persists through the standard `eliza_character_persistence` service.
 */
export const manageMessageExamplesAction: Action = {
	name: "MANAGE_MESSAGE_EXAMPLES",
	contexts: ["settings", "messaging", "agent_internal"],
	roleGate: { minRole: "ADMIN" },
	similes: [
		"UPDATE_MESSAGE_EXAMPLES",
		"EDIT_MESSAGE_EXAMPLES",
		"ADD_MESSAGE_EXAMPLE",
		"REMOVE_MESSAGE_EXAMPLE",
		"EDIT_MESSAGE_EXAMPLE",
	],
	description:
		"Adds, removes, or edits a turn or whole conversation inside character.messageExamples. Use this when the user wants to manage individual sample exchanges that demonstrate how the agent should reply.",
	suppressPostActionContinuation: true,
	parameters: [
		{
			name: "action",
			description:
				"Operation to perform: 'add' a new turn or conversation, 'remove' a turn or conversation, 'edit' the content of a specific turn.",
			required: true,
			schema: {
				type: "string" as const,
				enum: ["add", "remove", "edit"],
			},
		},
		{
			name: "conversationIndex",
			description:
				"0-based index of the target conversation group inside character.messageExamples. For 'add' with no existing groups, pass 0 to create the first one.",
			required: true,
			schema: { type: "number" as const },
		},
		{
			name: "turnIndex",
			description:
				"0-based index of the target turn inside the conversation. Omit for whole-conversation operations on 'add' (start a new conversation) and 'remove' (delete the whole conversation). Required for 'edit'.",
			required: false,
			schema: { type: "number" as const },
		},
		{
			name: "content",
			description:
				"For 'add' and 'edit': the role ('user' or 'agent') and text of the turn.",
			required: false,
			schema: {
				type: "object" as const,
				properties: {
					role: {
						type: "string" as const,
						enum: ["user", "agent"],
					},
					text: { type: "string" as const },
				},
			},
		},
	],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> =>
		hasActionContextOrKeyword(message, state, {
			contexts: ["settings", "messaging", "agent_internal"],
			keywords: [
				"message examples",
				"sample exchanges",
				"example replies",
				"add message example",
				"edit message example",
				"remove message example",
			],
		}),

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: Record<string, unknown>,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const params = (options?.parameters ??
			{}) as ManageMessageExamplesParameters;
		const exampleAction = params.action?.trim();
		const conversationIndex = normalizeIndex(params.conversationIndex);
		const turnIndex = normalizeIndex(params.turnIndex);
		const role = params.content?.role?.trim();
		const text = params.content?.text;

		if (!isExampleAction(exampleAction)) {
			const errMsg =
				"I need a valid action ('add', 'remove', or 'edit') to update message examples.";
			await callback?.({ text: errMsg, thought: "Invalid example action" });
			return {
				text: errMsg,
				success: false,
				values: { error: "invalid_action" },
				data: { action: "MANAGE_MESSAGE_EXAMPLES" },
			};
		}

		if (conversationIndex === undefined) {
			const errMsg =
				"I need a non-negative integer conversationIndex to update message examples.";
			await callback?.({
				text: errMsg,
				thought: "Missing conversationIndex",
			});
			return {
				text: errMsg,
				success: false,
				values: { error: "missing_conversation_index" },
				data: { action: "MANAGE_MESSAGE_EXAMPLES" },
			};
		}

		try {
			const current: MessageExampleGroup[] = (
				runtime.character.messageExamples ?? []
			).map((group: MessageExampleGroup) => ({
				examples: group.examples.map((entry: MessageExample) => ({
					name: entry.name,
					content: { ...entry.content },
				})),
			}));
			let summary = "";

			if (exampleAction === "add") {
				if (!isExampleRole(role) || typeof text !== "string" || !text.trim()) {
					const errMsg =
						"To add a message example I need content.role ('user' or 'agent') and content.text.";
					await callback?.({
						text: errMsg,
						thought: "Missing content for add",
					});
					return {
						text: errMsg,
						success: false,
						values: { error: "missing_content" },
						data: { action: "MANAGE_MESSAGE_EXAMPLES" },
					};
				}

				const newExample: MessageExample = {
					name: resolveExampleSpeaker(runtime, role),
					content: { text: text.trim() },
				};

				if (conversationIndex < current.length) {
					const group = current[conversationIndex];
					const nextExamples = [...group.examples];
					if (turnIndex !== undefined && turnIndex <= nextExamples.length) {
						nextExamples.splice(turnIndex, 0, newExample);
					} else {
						nextExamples.push(newExample);
					}
					current[conversationIndex] = { examples: nextExamples };
					summary = `Added new turn to conversation ${conversationIndex}.`;
				} else if (conversationIndex === current.length) {
					current.push({ examples: [newExample] });
					summary = `Started new conversation at index ${conversationIndex}.`;
				} else {
					const errMsg = `conversationIndex ${conversationIndex} is out of range (have ${current.length} conversations).`;
					await callback?.({ text: errMsg, thought: "Index out of range" });
					return {
						text: errMsg,
						success: false,
						values: { error: "index_out_of_range" },
						data: { action: "MANAGE_MESSAGE_EXAMPLES" },
					};
				}
			} else if (exampleAction === "remove") {
				if (conversationIndex >= current.length) {
					const errMsg = `conversationIndex ${conversationIndex} is out of range.`;
					await callback?.({ text: errMsg, thought: "Index out of range" });
					return {
						text: errMsg,
						success: false,
						values: { error: "index_out_of_range" },
						data: { action: "MANAGE_MESSAGE_EXAMPLES" },
					};
				}
				if (turnIndex === undefined) {
					current.splice(conversationIndex, 1);
					summary = `Removed conversation ${conversationIndex}.`;
				} else {
					const group = current[conversationIndex];
					if (turnIndex >= group.examples.length) {
						const errMsg = `turnIndex ${turnIndex} is out of range.`;
						await callback?.({ text: errMsg, thought: "Index out of range" });
						return {
							text: errMsg,
							success: false,
							values: { error: "index_out_of_range" },
							data: { action: "MANAGE_MESSAGE_EXAMPLES" },
						};
					}
					const nextExamples = [...group.examples];
					nextExamples.splice(turnIndex, 1);
					if (nextExamples.length === 0) {
						current.splice(conversationIndex, 1);
						summary = `Removed turn ${turnIndex} (and the now-empty conversation ${conversationIndex}).`;
					} else {
						current[conversationIndex] = { examples: nextExamples };
						summary = `Removed turn ${turnIndex} from conversation ${conversationIndex}.`;
					}
				}
			} else {
				// edit
				if (turnIndex === undefined) {
					const errMsg = "To edit a message example I need a turnIndex.";
					await callback?.({ text: errMsg, thought: "Missing turnIndex" });
					return {
						text: errMsg,
						success: false,
						values: { error: "missing_turn_index" },
						data: { action: "MANAGE_MESSAGE_EXAMPLES" },
					};
				}
				if (conversationIndex >= current.length) {
					const errMsg = `conversationIndex ${conversationIndex} is out of range.`;
					await callback?.({ text: errMsg, thought: "Index out of range" });
					return {
						text: errMsg,
						success: false,
						values: { error: "index_out_of_range" },
						data: { action: "MANAGE_MESSAGE_EXAMPLES" },
					};
				}
				const group = current[conversationIndex];
				if (turnIndex >= group.examples.length) {
					const errMsg = `turnIndex ${turnIndex} is out of range.`;
					await callback?.({ text: errMsg, thought: "Index out of range" });
					return {
						text: errMsg,
						success: false,
						values: { error: "index_out_of_range" },
						data: { action: "MANAGE_MESSAGE_EXAMPLES" },
					};
				}
				if (!isExampleRole(role) || typeof text !== "string" || !text.trim()) {
					const errMsg =
						"To edit a message example I need content.role ('user' or 'agent') and content.text.";
					await callback?.({
						text: errMsg,
						thought: "Missing content for edit",
					});
					return {
						text: errMsg,
						success: false,
						values: { error: "missing_content" },
						data: { action: "MANAGE_MESSAGE_EXAMPLES" },
					};
				}
				const nextExamples = [...group.examples];
				nextExamples[turnIndex] = {
					name: resolveExampleSpeaker(runtime, role),
					content: { text: text.trim() },
				};
				current[conversationIndex] = { examples: nextExamples };
				summary = `Edited turn ${turnIndex} of conversation ${conversationIndex}.`;
			}

			const result = await persistCharacterPatch(runtime, {
				messageExamples: current,
			});

			if (!result.success) {
				const errMsg = `I couldn't save the message-example change: ${result.error ?? "unknown error"}`;
				await callback?.({
					text: errMsg,
					thought: "Message example persistence failed",
				});
				return {
					text: errMsg,
					success: false,
					values: { error: result.error ?? "persistence_failed" },
					data: { action: "MANAGE_MESSAGE_EXAMPLES" },
				};
			}

			await callback?.({
				text: summary,
				thought: `Applied message example change: action=${exampleAction}; conversationIndex=${conversationIndex}; turnIndex=${turnIndex ?? "none"}`,
				actions: ["MANAGE_MESSAGE_EXAMPLES"],
			});

			return {
				text: summary,
				success: true,
				values: {
					action: exampleAction,
					conversationIndex,
					turnIndex: turnIndex ?? null,
					totalConversations: current.length,
				},
				data: {
					action: "MANAGE_MESSAGE_EXAMPLES",
					exampleChange: {
						operation: exampleAction,
						conversationIndex,
						turnIndex: turnIndex ?? null,
					},
				},
			};
		} catch (error) {
			logger.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"Error in MANAGE_MESSAGE_EXAMPLES action",
			);
			const errMsg = "I encountered an error while updating message examples.";
			await callback?.({
				text: errMsg,
				thought: `Error in manage message examples: ${(error as Error).message}`,
			});
			return {
				text: errMsg,
				success: false,
				values: { error: (error as Error).message },
				data: {
					action: "MANAGE_MESSAGE_EXAMPLES",
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
					text: "Add an agent reply 'Sure, I can help with that.' to the first sample conversation.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Added new turn to conversation 0.",
					actions: ["MANAGE_MESSAGE_EXAMPLES"],
				},
			},
		],
		[
			{
				name: "{{user}}",
				content: {
					text: "Delete the second sample conversation entirely.",
				},
			},
			{
				name: "{{agent}}",
				content: {
					text: "Removed conversation 1.",
					actions: ["MANAGE_MESSAGE_EXAMPLES"],
				},
			},
		],
	] as ActionExample[][],
};
