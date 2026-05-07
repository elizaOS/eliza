import {
	type Action,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	type JsonValue,
	logger,
	type Memory,
	type State,
} from "../../../../types/index.ts";
import { hasActionContextOrKeyword } from "../../../../utils/action-validation.ts";
import {
	listConversationAttachments,
	readAttachmentRecord,
	summarizeAttachment,
} from "../services/attachmentContext.ts";
import { maybeStoreTaskClipboardItem } from "../services/taskClipboardPersistence.ts";

type SaveAttachmentParameters = {
	attachmentId?: JsonValue;
	id?: JsonValue;
	title?: JsonValue;
};

function readStringValue(value: JsonValue | undefined): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function getParameters(options: HandlerOptions | undefined) {
	return (options?.parameters ?? {}) as SaveAttachmentParameters;
}

function resolveAttachmentId(
	message: Memory,
	options: HandlerOptions | undefined,
) {
	const params = getParameters(options);
	return (
		readStringValue(params.attachmentId) ??
		readStringValue(params.id) ??
		readStringValue(message.content.attachmentId as JsonValue | undefined) ??
		readStringValue(message.content.id as JsonValue | undefined)
	);
}

function resolveTitle(message: Memory, options: HandlerOptions | undefined) {
	const params = getParameters(options);
	return (
		readStringValue(params.title) ??
		readStringValue(message.content.clipboardTitle as JsonValue | undefined) ??
		readStringValue(message.content.title as JsonValue | undefined)
	);
}

export const saveAttachmentToClipboardAction: Action = {
	name: "SAVE_ATTACHMENT_TO_CLIPBOARD",
	contexts: ["files", "media", "messaging", "knowledge"],
	roleGate: { minRole: "ADMIN" },
	similes: [
		"ADD_ATTACHMENT_TO_CLIPBOARD",
		"STORE_ATTACHMENT_IN_CLIPBOARD",
		"SAVE_OUTPUT_TO_CLIPBOARD",
	],
	description:
		"Save a stored conversation attachment into bounded task clipboard state. Use after an action produces an attachment that should remain available for chained work.",
	suppressActionResultClipboard: true,
	suppressPostActionContinuation: true,
	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state?: State,
		options?: HandlerOptions | Record<string, JsonValue | undefined>,
	): Promise<boolean> => {
		const handlerOptions =
			options && typeof options === "object" && "parameters" in options
				? (options as HandlerOptions)
				: undefined;
		const hasAttachmentId = Boolean(
			resolveAttachmentId(message, handlerOptions),
		);
		if (/save|store|keep|clipboard/i.test(String(message.content.text ?? ""))) {
			return (
				hasAttachmentId ||
				(await listConversationAttachments(runtime, message)).length > 0
			);
		}
		return (
			hasAttachmentId ||
			hasActionContextOrKeyword(message, _state, {
				contexts: ["files", "media", "messaging", "knowledge"],
				keywords: [
					"save attachment",
					"store attachment",
					"keep attachment",
					"attachment clipboard",
				],
			})
		);
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		options: HandlerOptions | undefined,
		callback?: HandlerCallback,
	) => {
		try {
			const attachmentId = resolveAttachmentId(message, options);
			const result = await readAttachmentRecord(runtime, message, attachmentId);
			if (!result) {
				const attachments = (
					await listConversationAttachments(runtime, message)
				).slice(0, 10);
				const text = attachments.length
					? `Available attachments:\n${attachments.map(summarizeAttachment).join("\n\n")}`
					: "No attachments are available to save to the clipboard.";
				await callback?.({
					text,
					actions: ["SAVE_ATTACHMENT_TO_CLIPBOARD_FAILED"],
					source: message.content.source,
				});
				return {
					success: false,
					text,
					data: { actionName: "SAVE_ATTACHMENT_TO_CLIPBOARD" },
				};
			}

			const title = resolveTitle(message, options);
			const content = result.content.trim();
			const clipboardResult = await maybeStoreTaskClipboardItem(
				runtime,
				{
					...message,
					content: {
						...message.content,
						addToClipboard: true,
						...(title ? { clipboardTitle: title } : {}),
					},
				},
				{
					fallbackTitle: result.attachment.title || result.attachment.id,
					content,
					sourceType: "attachment",
					sourceId: result.attachment.id,
					sourceLabel: result.attachment.title || result.attachment.url,
					mimeType: result.attachment.contentType,
				},
			);

			const text =
				clipboardResult.stored === true
					? `${clipboardResult.replaced ? "Updated" : "Added"} clipboard item ${clipboardResult.item.id}: ${clipboardResult.item.title}`
					: `Clipboard add skipped: ${"reason" in clipboardResult ? clipboardResult.reason : "clipboard storage was not requested"}`;
			await callback?.({
				text,
				actions: [
					clipboardResult.stored
						? "SAVE_ATTACHMENT_TO_CLIPBOARD_SUCCESS"
						: "SAVE_ATTACHMENT_TO_CLIPBOARD_FAILED",
				],
				source: message.content.source,
			});

			return {
				success: clipboardResult.stored,
				text,
				data: {
					actionName: "SAVE_ATTACHMENT_TO_CLIPBOARD",
					attachmentId: result.attachment.id,
					attachment: result.attachment,
					clipboard: clipboardResult,
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error("[SaveAttachmentToClipboard] Error:", errorMessage);
			await callback?.({
				text: `Failed to save attachment to clipboard: ${errorMessage}`,
				actions: ["SAVE_ATTACHMENT_TO_CLIPBOARD_FAILED"],
				source: message.content.source,
			});
			return {
				success: false,
				text: "Failed to save attachment to clipboard",
				error: errorMessage,
				data: { actionName: "SAVE_ATTACHMENT_TO_CLIPBOARD" },
			};
		}
	},
	parameters: [
		{
			name: "attachmentId",
			description:
				"The ID of the stored attachment to save into bounded task clipboard state.",
			required: false,
			schema: { type: "string" },
		},
		{
			name: "title",
			description: "Optional clipboard title for the saved attachment content.",
			required: false,
			schema: { type: "string" },
		},
	],
	examples: [],
};

export default saveAttachmentToClipboardAction;
