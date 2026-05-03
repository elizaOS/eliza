/**
 * @module actions/restore
 * @description Action for restoring stashed form sessions
 *
 * The restore operation is unique among form intents because:
 * 1. Timing Matters: The restored form context must be available BEFORE response generation
 * 2. Preemption: FORM_RESTORE should preempt REPLY
 * 3. Immediate Context: After restore, the provider gives the agent the restored form context
 */

import {
	type Action,
	type ActionResult,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	logger,
	type Memory,
	type State,
	type UUID,
} from "../../../../types/index.ts";
import { quickIntentDetect } from "../intent.ts";
import type { FormService } from "../service.ts";

export const formRestoreAction: Action = {
	name: "FORM_RESTORE",
	similes: ["RESUME_FORM", "CONTINUE_FORM"],
	description: "Restore a previously stashed form session",

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
	): Promise<boolean> => {
		try {
			const text = message.content?.text || "";

			const intent = quickIntentDetect(text);
			if (intent !== "restore") {
				return false;
			}

			const formService = runtime.getService("FORM") as FormService;
			if (!formService) {
				return false;
			}

			const entityId = message.entityId as UUID;
			if (!entityId) return false;
			const stashed = await formService.getStashedSessions(entityId);

			return stashed.length > 0;
		} catch (error) {
			logger.error("[FormRestoreAction] Validation error:", String(error));
			return false;
		}
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		_options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		try {
			const formService = runtime.getService("FORM") as FormService;
			if (!formService) {
				await callback?.({
					text: "Sorry, I couldn't find the form service.",
				});
				return { success: false };
			}

			const entityId = message.entityId as UUID;
			const roomId = message.roomId as UUID;

			if (!entityId || !roomId) {
				await callback?.({
					text: "Sorry, I couldn't identify you.",
				});
				return { success: false };
			}

			// Check for existing active session in this room
			const existing = await formService.getActiveSession(entityId, roomId);
			if (existing) {
				const form = formService.getForm(existing.formId);
				await callback?.({
					text: `You already have an active form: "${form?.name || existing.formId}". Would you like to continue with that one, or should I save it and restore your other form?`,
				});
				return { success: false };
			}

			const stashed = await formService.getStashedSessions(entityId);

			if (stashed.length === 0) {
				await callback?.({
					text: "You don't have any saved forms to resume.",
				});
				return { success: false };
			}

			// Restore the most recent stashed session
			const sessionToRestore = stashed.sort(
				(a, b) => b.updatedAt - a.updatedAt,
			)[0];
			const session = await formService.restore(sessionToRestore.id, entityId);

			const form = formService.getForm(session.formId);
			const context = formService.getSessionContext(session);

			let responseText = `I've restored your "${form?.name || session.formId}" form. `;
			responseText += `You're ${context.progress}% complete. `;

			if (context.filledFields.length > 0) {
				responseText += `\n\nHere's what I have so far:\n`;
				for (const field of context.filledFields) {
					responseText += `\u2022 ${field.label}: ${field.displayValue}\n`;
				}
			}

			if (context.nextField) {
				responseText += `\nLet's continue with ${context.nextField.label}.`;
				if (context.nextField.askPrompt) {
					responseText += ` ${context.nextField.askPrompt}`;
				}
			} else if (context.status === "ready") {
				responseText += `\nEverything looks complete! Ready to submit?`;
			}

			await callback?.({
				text: responseText,
			});

			return {
				success: true,
				data: {
					sessionId: session.id,
					formId: session.formId,
					progress: context.progress,
				},
			};
		} catch (error) {
			logger.error("[FormRestoreAction] Handler error:", String(error));
			await callback?.({
				text: "Sorry, I couldn't restore your form. Please try again.",
			});
			return { success: false };
		}
	},

	examples: [
		[
			{
				name: "{{user1}}",
				content: { text: "Resume my form" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "I've restored your form. Let's continue where you left off.",
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "Continue with my registration" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "I've restored your Registration form. You're 60% complete.",
				},
			},
		],
		[
			{
				name: "{{user1}}",
				content: { text: "Pick up where I left off" },
			},
			{
				name: "{{agentName}}",
				content: {
					text: "I've restored your form. Here's what you have so far...",
				},
			},
		],
	],
};

export default formRestoreAction;
