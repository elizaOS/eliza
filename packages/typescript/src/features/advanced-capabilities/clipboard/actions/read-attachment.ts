import {
	type Action,
	ContentType,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	logger,
	type Memory,
	type State,
} from "../../../../types/index.ts";
import {
	listConversationAttachments,
	readAttachmentRecord,
	summarizeAttachment,
} from "../services/attachmentContext.ts";
import { maybeStoreTaskClipboardItem } from "../services/taskClipboardPersistence.ts";

export const readAttachmentAction: Action = {
	name: "READ_ATTACHMENT",
	similes: ["OPEN_ATTACHMENT", "INSPECT_ATTACHMENT"],
	description:
		"Read a stored attachment by attachment ID. Use this instead of relying on inline attachment descriptions in the conversation context. Set addToClipboard=true to keep the result in bounded task clipboard state.",
	validate: async (runtime, message) => {
		const isAttachmentRequest =
			typeof message.content.attachmentId === "string" ||
			/attachment|image|screenshot|file/i.test(
				String(message.content.text ?? ""),
			);
		if (!isAttachmentRequest) {
			return false;
		}

		const attachments = await listConversationAttachments(runtime, message);
		return attachments.length > 0;
	},
	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		_state: State | undefined,
		_options: HandlerOptions | undefined,
		callback?: HandlerCallback,
	) => {
		try {
			const explicitId =
				typeof message.content.attachmentId === "string"
					? message.content.attachmentId.trim()
					: null;
			const result = await readAttachmentRecord(runtime, message, explicitId);
			if (!result) {
				const attachments = await listConversationAttachments(runtime, message);
				const fallback = attachments.length
					? `Available attachments:\n${attachments.map(summarizeAttachment).join("\n\n")}`
					: "No attachments are available in the current conversation window.";
				if (callback) {
					await callback({
						text: fallback,
						actions: ["READ_ATTACHMENT_FAILED"],
						source: message.content.source,
					});
				}
				return { success: false, text: fallback };
			}

			const storedContent = result.content.trim();
			const clipboardResult = await maybeStoreTaskClipboardItem(
				runtime,
				message,
				{
					fallbackTitle: result.attachment.title || result.attachment.id,
					content: storedContent,
					sourceType:
						result.attachment.contentType === ContentType.IMAGE
							? "image_attachment"
							: "attachment",
					sourceId: result.attachment.id,
					sourceLabel: result.attachment.title || result.attachment.url,
					mimeType: result.attachment.contentType,
				},
			);
			let clipboardStatusText = "";
			if (clipboardResult.requested) {
				if (clipboardResult.stored) {
					clipboardStatusText = `${clipboardResult.replaced ? "Updated" : "Added"} clipboard item ${clipboardResult.item.id}: ${clipboardResult.item.title}`;
				} else if ("reason" in clipboardResult) {
					clipboardStatusText = `Clipboard add skipped: ${clipboardResult.reason}`;
				}
			}
			const responseText = [
				summarizeAttachment(result.attachment),
				result.autoSelected
					? "Selection: auto-selected because no attachment ID was provided."
					: "",
				clipboardStatusText,
				clipboardResult.requested && clipboardResult.stored
					? `Clipboard usage: ${clipboardResult.snapshot.items.length}/${clipboardResult.snapshot.maxItems}.`
					: "",
				clipboardResult.requested && clipboardResult.stored
					? "Clear unused clipboard state when it is no longer needed."
					: "",
				"",
				storedContent ||
					"No stored attachment content is available for this attachment.",
			]
				.filter(Boolean)
				.join("\n");

			if (callback) {
				await callback({
					text: responseText,
					actions: ["READ_ATTACHMENT_SUCCESS"],
					source: message.content.source,
				});
			}

			return {
				success: true,
				text: responseText,
				data: {
					attachmentId: result.attachment.id,
					attachment: result.attachment,
					content: storedContent,
					clipboard: clipboardResult,
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error("[ClipboardReadAttachment] Error:", errorMessage);
			if (callback) {
				await callback({
					text: `Failed to read attachment: ${errorMessage}`,
					actions: ["READ_ATTACHMENT_FAILED"],
					source: message.content.source,
				});
			}
			return {
				success: false,
				text: "Failed to read attachment",
				error: errorMessage,
			};
		}
	},
	examples: [],
};

export default readAttachmentAction;
