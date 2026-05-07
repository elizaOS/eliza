import { logger } from "../../../../logger.ts";
import type {
	Action,
	ActionExample,
	ActionResult,
	HandlerCallback,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { getDefaultTriageService } from "../triage-service.ts";
import {
	messageIdParameter,
	parseManageMessageParams,
	validateMessageAction,
} from "./_shared.ts";

export const manageMessageAction: Action = {
	name: "MANAGE_MESSAGE",
	contexts: ["messaging", "email", "contacts"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Mutate a single message: archive, trash, mark spam, mark read/unread, add or remove a label or tag, mute thread, or unsubscribe. Routes to the source adapter; tag operations are stored locally if the connector lacks tagging.",
	descriptionCompressed:
		"manage one msg: archive trash spam mark-read label-add label-remove tag-add tag-remove mute-thread unsubscribe; capability-gated",
	similes: ["ARCHIVE_MESSAGE", "TAG_MESSAGE", "UNSUBSCRIBE", "MARK_READ"],
	parameters: [
		messageIdParameter,
		{
			name: "source",
			description: "Optional source connector for the message.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "operation",
			description:
				"Operation to apply: archive, trash, spam, mark_read, label_add, label_remove, tag_add, tag_remove, mute_thread, or unsubscribe.",
			required: true,
			schema: { type: "string" as const },
		},
		{
			name: "label",
			description: "Label for label_add or label_remove.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "tag",
			description: "Tag for tag_add or tag_remove.",
			required: false,
			schema: { type: "string" as const },
		},
	],
	examples: [
		[
			{
				name: "User",
				content: { text: "Archive that newsletter" },
			},
			{
				name: "Agent",
				content: { text: "Archived.", action: "MANAGE_MESSAGE" },
			},
		],
	] as ActionExample[][],

	validate: async (
		_runtime: IAgentRuntime,
		message: Memory,
		state?: State,
	): Promise<boolean> => validateMessageAction(message, state),

	handler: async (
		runtime: IAgentRuntime,
		_message: Memory,
		_state?: State,
		options?: HandlerOptions,
		callback?: HandlerCallback,
	): Promise<ActionResult> => {
		const parsed = parseManageMessageParams(options);
		if ("error" in parsed) {
			logger.warn(`[ManageMessage] ${parsed.error}`);
			return { success: false, text: parsed.error, error: parsed.error };
		}

		const service = getDefaultTriageService();
		const result = await service.manage(
			runtime,
			parsed.messageId,
			parsed.operation,
			{
				source: parsed.source,
			},
		);

		const opLabel = parsed.operation.kind;
		if (!result.ok) {
			const text =
				result.reason ??
				`Operation ${opLabel} on message ${parsed.messageId} did not complete.`;
			logger.info(
				`[ManageMessage] op=${opLabel} messageId=${parsed.messageId} not ok: ${text}`,
			);
			if (callback) {
				await callback({ text, action: "MANAGE_MESSAGE" });
			}
			return {
				success: false,
				text,
				data: {
					ok: false,
					reason: result.reason ?? null,
					messageId: parsed.messageId,
					operation: opLabel,
				},
			};
		}

		const text = `Applied ${opLabel} to message ${parsed.messageId}.`;
		logger.info(
			`[ManageMessage] op=${opLabel} messageId=${parsed.messageId} ok`,
		);
		if (callback) {
			await callback({ text, action: "MANAGE_MESSAGE" });
		}
		return {
			success: true,
			text,
			data: {
				ok: true,
				messageId: parsed.messageId,
				operation: opLabel,
			},
		};
	},
};
