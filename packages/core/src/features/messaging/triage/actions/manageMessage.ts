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
import type { TriageService } from "../triage-service.ts";
import {
	type ManageMessageParams,
	messageIdParameter,
	parseManageMessageParams,
	validateMessageAction,
} from "./_shared.ts";

async function resolveTargetMessageId(
	runtime: IAgentRuntime,
	service: TriageService,
	parsed: ManageMessageParams,
): Promise<string | null> {
	if (parsed.messageId) return parsed.messageId;
	const hits = await service.search(runtime, {
		...parsed.lookup,
		sources: parsed.lookup.sources ?? (parsed.source ? [parsed.source] : undefined),
		limit: 1,
	});
	return hits[0]?.id ?? null;
}

export const manageMessageAction: Action = {
	name: "MANAGE_MESSAGE",
	contexts: ["messaging", "email", "contacts"],
	roleGate: { minRole: "ADMIN" },
	description:
		"Mutate a single message or sender: archive, trash, mark spam, mark read/unread, add or remove a label or tag, mute thread, unsubscribe, or block a sender. Use this for unsubscribe/block/archive/delete/label requests, including natural-language targets like newsletters@medium.com; pass messageId when known, otherwise pass sender/content hints.",
	descriptionCompressed:
		"mutate msg/sender: archive trash spam mark-read label tag mute unsubscribe block; target by messageId or sender/content",
	similes: ["ARCHIVE_MESSAGE", "TAG_MESSAGE", "UNSUBSCRIBE", "BLOCK_SENDER", "MARK_READ"],
	parameters: [
		{ ...messageIdParameter, required: false },
		{
			name: "sender",
			description:
				"Optional sender name, email, or handle when messageId is unknown.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "content",
			description:
				"Optional subject/body keyword hint for locating the message.",
			required: false,
			schema: { type: "string" as const },
		},
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
		const messageId = await resolveTargetMessageId(runtime, service, parsed);
		if (!messageId) {
			const text = "No matching message found to manage.";
			logger.warn(`[ManageMessage] ${text}`);
			return { success: false, text, error: text };
		}
		const result = await service.manage(
			runtime,
			messageId,
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
					messageId,
					operation: opLabel,
				},
			};
		}

		const text = `Applied ${opLabel} to message ${messageId}.`;
		logger.info(
			`[ManageMessage] op=${opLabel} messageId=${messageId} ok`,
		);
		if (callback) {
			await callback({ text, action: "MANAGE_MESSAGE" });
		}
		return {
			success: true,
			text,
			data: {
				ok: true,
				messageId,
				operation: opLabel,
			},
		};
	},
};
