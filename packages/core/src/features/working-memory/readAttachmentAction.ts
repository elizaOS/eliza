import {
	type Action,
	ContentType,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	logger,
	type Memory,
	ModelType,
	type State,
} from "../../types/index.ts";
import {
	listConversationAttachments,
	readAttachmentRecords,
	summarizeAttachment,
} from "./attachmentContext.ts";
import { maybeStoreTaskClipboardItem } from "./taskClipboardPersistence.ts";

const MAX_ATTACHMENT_ANSWER_CHARS = 32_000;
const MIN_ATTACHMENT_ANSWER_TOKENS = 1024;
const MAX_ATTACHMENT_ANSWER_TOKENS = 4096;
const ATTACHMENT_REQUEST_PATTERN =
	/\b(?:attachment|file|document|doc|pdf|image|screenshot|picture|photo|audio|voice|recording|song|video|media|transcript|url|link|webpage|website|page|article)\b/i;
type AttachmentRecord = Awaited<
	ReturnType<typeof readAttachmentRecords>
>[number];

function shouldShowAttachmentRecord(messageText: string): boolean {
	return /\b(?:attachment|file)\s+(?:id|ids|metadata|details|info|record)\b/i.test(
		messageText,
	);
}

function attachmentContentForAnswering(content: string): string {
	if (content.length <= MAX_ATTACHMENT_ANSWER_CHARS) {
		return content;
	}
	return `${content.slice(0, MAX_ATTACHMENT_ANSWER_CHARS)}\n\n[Attachment content truncated before answering because it exceeded ${MAX_ATTACHMENT_ANSWER_CHARS} characters.]`;
}

function attachmentAnswerTokenBudget(content: string): number {
	const estimatedTokens = Math.ceil(content.length / 4);
	return Math.min(
		Math.max(estimatedTokens, MIN_ATTACHMENT_ANSWER_TOKENS),
		MAX_ATTACHMENT_ANSWER_TOKENS,
	);
}

function missingReadableContentMessage(records: AttachmentRecord[]): string {
	const hasOnlyImages = records.every(
		(record) => record.attachment.contentType === ContentType.IMAGE,
	);
	if (hasOnlyImages) {
		return records.length === 1
			? "I couldn't generate a readable description for that image."
			: "I couldn't generate readable descriptions for those images.";
	}
	const hasOnlyMedia = records.every(
		(record) =>
			record.attachment.contentType === ContentType.AUDIO ||
			record.attachment.contentType === ContentType.VIDEO,
	);
	if (hasOnlyMedia) {
		return records.length === 1
			? "I don't have a transcript for that attachment yet."
			: "I don't have transcripts for those attachments yet.";
	}
	return records.length === 1
		? "I don't have readable text for that attachment yet."
		: "I don't have readable text for those attachments yet.";
}

function titleForRecord(record: AttachmentRecord): string {
	return (
		record.attachment.title?.trim() ||
		record.attachment.url ||
		record.attachment.id
	);
}

function contentForRecords(records: AttachmentRecord[]): string {
	if (records.length === 1) {
		return records[0]?.content.trim() ?? "";
	}
	return records
		.map((record, index) => {
			const content = record.content.trim();
			const title = titleForRecord(record);
			return [
				`Attachment ${index + 1}: ${title}`,
				content || "[No readable content is available for this attachment.]",
			].join("\n");
		})
		.join("\n\n")
		.trim();
}

function hasReadableContent(records: AttachmentRecord[]): boolean {
	return records.some((record) => record.content.trim().length > 0);
}

function attachmentSourceType(
	records: AttachmentRecord[],
): "attachment" | "image_attachment" {
	return records.every(
		(record) => record.attachment.contentType === ContentType.IMAGE,
	)
		? "image_attachment"
		: "attachment";
}

function responseRecordText(params: {
	records: AttachmentRecord[];
	clipboardStatusText: string;
	clipboardResult: Awaited<ReturnType<typeof maybeStoreTaskClipboardItem>>;
	storedContent: string;
}): string {
	const summaries = params.records.map((record) =>
		summarizeAttachment(record.attachment),
	);
	return [
		...summaries,
		params.records.some((record) => record.autoSelected)
			? "Selection: auto-selected because no attachment ID was provided."
			: "",
		params.clipboardStatusText,
		params.clipboardResult.requested && params.clipboardResult.stored
			? `Clipboard usage: ${params.clipboardResult.snapshot.items.length}/${params.clipboardResult.snapshot.maxItems}.`
			: "",
		params.clipboardResult.requested && params.clipboardResult.stored
			? "Clear unused clipboard state when it is no longer needed."
			: "",
		"",
		params.storedContent ||
			"No stored attachment content is available for these attachments.",
	]
		.filter(Boolean)
		.join("\n");
}

async function answerAttachmentRequest(params: {
	runtime: IAgentRuntime;
	message: Memory;
	content: string;
}): Promise<string> {
	const userRequest =
		typeof params.message.content.text === "string"
			? params.message.content.text.trim()
			: "";
	const prompt = [
		"You are answering a user request about an attachment.",
		"Use only the attachment content, extracted text, transcript, or media description below.",
		'Follow explicit formatting instructions from the user, including requests such as "only" or "keep it short".',
		"If the requested answer is not in the attachment content, say that briefly.",
		"Do not include attachment metadata, IDs, source labels, or implementation details.",
		"",
		`User request:\n${userRequest || "Read the attachment."}`,
		"",
		`Attachment content:\n${attachmentContentForAnswering(params.content)}`,
	].join("\n");
	const response = await params.runtime.useModel(ModelType.TEXT_SMALL, {
		prompt,
		temperature: 0,
		maxTokens: attachmentAnswerTokenBudget(params.content),
	});
	const text = String(response).trim();
	return text || params.content;
}

function getActionParams(
	options: HandlerOptions | undefined,
): Record<string, unknown> {
	const direct =
		options && typeof options === "object"
			? (options as Record<string, unknown>)
			: {};
	const parameters =
		direct.parameters && typeof direct.parameters === "object"
			? (direct.parameters as Record<string, unknown>)
			: {};
	return { ...direct, ...parameters };
}

function readAttachmentId(params: Record<string, unknown>): string | null {
	const value = params.attachmentId ?? params.id;
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export const readAttachmentAction: Action = {
	name: "READ_ATTACHMENT",
	contexts: ["files", "media", "messaging", "knowledge"],
	roleGate: { minRole: "ADMIN" },
	similes: [
		"OPEN_ATTACHMENT",
		"INSPECT_ATTACHMENT",
		"READ_URL",
		"OPEN_URL",
		"READ_WEBPAGE",
	],
	description:
		"Read current or recent attachments and link previews using extracted text, transcripts, page content, or media descriptions. Set addToClipboard=true to keep the result in bounded task clipboard state.",
	suppressPostActionContinuation: true,
	validate: async (runtime, message) => {
		const params = message.content as Record<string, unknown>;
		const isAttachmentRequest =
			readAttachmentId(params) !== null ||
			typeof message.content.attachmentId === "string" ||
			(message.content.attachments?.length ?? 0) > 0 ||
			ATTACHMENT_REQUEST_PATTERN.test(String(message.content.text ?? ""));
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
			const params = getActionParams(_options);
			const messageWithParams: Memory = {
				...message,
				content: {
					...message.content,
					...params,
				} as Memory["content"],
			};
			const explicitId =
				readAttachmentId(params) ??
				(typeof message.content.attachmentId === "string"
					? message.content.attachmentId.trim()
					: null);
			const records = await readAttachmentRecords(
				runtime,
				messageWithParams,
				explicitId,
			);
			if (records.length === 0) {
				const attachments = await listConversationAttachments(
					runtime,
					messageWithParams,
				);
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
				return {
					success: false,
					text: fallback,
					data: { actionName: "READ_ATTACHMENT" },
				};
			}

			const hasContent = hasReadableContent(records);
			const storedContent = hasContent ? contentForRecords(records) : "";
			const clipboardResult = await maybeStoreTaskClipboardItem(
				runtime,
				messageWithParams,
				{
					fallbackTitle:
						records.length === 1
							? titleForRecord(records[0])
							: `${records.length} attachments`,
					content: storedContent,
					sourceType: attachmentSourceType(records),
					sourceId: records.map((record) => record.attachment.id).join(","),
					sourceLabel: records.map(titleForRecord).join(", "),
					mimeType:
						records.length === 1
							? records[0]?.attachment.contentType
							: undefined,
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
			const responseText = responseRecordText({
				records,
				clipboardStatusText,
				clipboardResult,
				storedContent,
			});
			const messageText =
				typeof messageWithParams.content.text === "string"
					? messageWithParams.content.text.trim()
					: "";
			const visibleText =
				hasContent &&
				!clipboardResult.requested &&
				!shouldShowAttachmentRecord(messageText)
					? await answerAttachmentRequest({
							runtime,
							message: messageWithParams,
							content: storedContent,
						})
					: !hasContent &&
							!clipboardResult.requested &&
							!shouldShowAttachmentRecord(messageText)
						? missingReadableContentMessage(records)
						: responseText;

			if (callback) {
				await callback({
					text: visibleText,
					actions: ["READ_ATTACHMENT_SUCCESS"],
					source: messageWithParams.content.source,
				});
			}

			return {
				success: true,
				text: visibleText,
				data: {
					actionName: "READ_ATTACHMENT",
					attachmentId: records[0]?.attachment.id,
					attachmentIds: records.map((record) => record.attachment.id),
					attachment: records[0]?.attachment,
					attachments: records.map((record) => record.attachment),
					content: storedContent,
					contents: records.map((record) => record.content.trim()),
					clipboard: clipboardResult,
					suppressActionResultClipboard: clipboardResult.requested,
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			logger.error("[ReadAttachment] Error:", errorMessage);
			if (callback) {
				await callback({
					text: "I couldn't read that attachment right now.",
					actions: ["READ_ATTACHMENT_FAILED"],
					source: message.content.source,
				});
			}
			return {
				success: false,
				text: "Failed to read attachment",
				error: errorMessage,
				data: { actionName: "READ_ATTACHMENT" },
			};
		}
	},
	parameters: [
		{
			name: "attachmentId",
			description:
				"Optional attachment ID to read. Omit to read current or recent attachments.",
			required: false,
			schema: { type: "string" as const },
		},
		{
			name: "addToClipboard",
			description:
				"When true, store the attachment content in bounded task clipboard state.",
			required: false,
			schema: { type: "boolean" as const, default: false },
		},
	],
	examples: [],
};

export default readAttachmentAction;
