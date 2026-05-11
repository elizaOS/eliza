import {
	type Action,
	type ActionResult,
	ContentType,
	type HandlerCallback,
	type HandlerOptions,
	type IAgentRuntime,
	logger,
	type Memory,
	ModelType,
	type State,
	type UUID,
} from "../../types/index.ts";
import { DocumentService } from "../documents/service.ts";
import {
	createDocumentNoteFilename,
	deriveDocumentTitle,
} from "../documents/utils.ts";
import {
	listConversationAttachments,
	readAttachmentRecords,
	summarizeAttachment,
} from "./attachmentContext.ts";
import { maybeStoreTaskClipboardItem } from "./taskClipboardPersistence.ts";

const ATTACHMENT_ACTIONS = ["read", "save_as_document"] as const;
const MAX_ATTACHMENT_ANSWER_CHARS = 32_000;
const MIN_ATTACHMENT_ANSWER_TOKENS = 1024;
const MAX_ATTACHMENT_ANSWER_TOKENS = 4096;
type AttachmentAction = (typeof ATTACHMENT_ACTIONS)[number];
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

function readAttachmentActionKind(
	params: Record<string, unknown>,
	message: Memory,
): AttachmentAction {
	const raw = params.action ?? params.subaction ?? params.op;
	if (typeof raw === "string") {
		const normalized = raw
			.trim()
			.toLowerCase()
			.replace(/[-\s]+/g, "_");
		if ((ATTACHMENT_ACTIONS as readonly string[]).includes(normalized)) {
			return normalized as AttachmentAction;
		}
	}
	const text =
		typeof message.content?.text === "string" ? message.content.text : "";
	return /\bsave\b[\s\S]{0,60}\b(?:document|doc|note|knowledge)\b/i.test(text)
		? "save_as_document"
		: "read";
}

function readStringParam(
	params: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = params[key];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function saveAttachmentAsDocument(params: {
	runtime: IAgentRuntime;
	message: Memory;
	records: AttachmentRecord[];
	content: string;
	actionParams: Record<string, unknown>;
	callback?: HandlerCallback;
}): Promise<ActionResult> {
	if (!params.content.trim()) {
		const text = missingReadableContentMessage(params.records);
		await params.callback?.({
			text,
			actions: ["ATTACHMENT_SAVE_AS_DOCUMENT_FAILED"],
			source: params.message.content.source,
		});
		return {
			success: false,
			text,
			data: {
				actionName: "ATTACHMENT",
				action: "save_as_document",
				attachmentIds: params.records.map((record) => record.attachment.id),
			},
		};
	}

	const service = params.runtime.getService<DocumentService>(
		DocumentService.serviceType,
	);
	if (!service) {
		const text = "Documents service not available.";
		await params.callback?.({
			text,
			actions: ["ATTACHMENT_SAVE_AS_DOCUMENT_FAILED"],
			source: params.message.content.source,
		});
		return {
			success: false,
			text,
			error: "DOCUMENTS_SERVICE_UNAVAILABLE",
			data: { actionName: "ATTACHMENT", action: "save_as_document" },
		};
	}

	const title =
		readStringParam(params.actionParams, "title") ??
		(params.records.length === 1
			? titleForRecord(params.records[0])
			: deriveDocumentTitle(params.content, "Saved attachments"));
	const filename = createDocumentNoteFilename(title);
	const stored = await service.addDocument({
		agentId: params.runtime.agentId as UUID,
		worldId: (params.message.worldId ??
			params.message.roomId ??
			params.runtime.agentId) as UUID,
		roomId: (params.message.roomId ?? params.runtime.agentId) as UUID,
		entityId: (params.message.entityId ?? params.runtime.agentId) as UUID,
		clientDocumentId: "" as UUID,
		contentType: "text/plain",
		originalFilename: filename,
		content: params.content,
		scope:
			params.actionParams.scope === "owner-private" ||
			params.actionParams.scope === "user-private" ||
			params.actionParams.scope === "agent-private" ||
			params.actionParams.scope === "global"
				? params.actionParams.scope
				: "owner-private",
		addedBy: params.message.entityId as UUID,
		addedByRole: "OWNER",
		addedFrom: "chat",
		metadata: {
			source: "attachment",
			title,
			filename,
			originalFilename: filename,
			fileExt: "txt",
			fileType: "text/plain",
			contentType: "text/plain",
			fileSize: Buffer.byteLength(params.content, "utf8"),
			textBacked: true,
			attachmentIds: params.records.map((record) => record.attachment.id),
			attachmentTitles: params.records.map(titleForRecord),
		},
	});
	const text = `Saved "${title}" as a document. Document id: ${stored.clientDocumentId}.`;
	await params.callback?.({
		text,
		actions: ["ATTACHMENT_SAVE_AS_DOCUMENT_SUCCESS"],
		source: params.message.content.source,
	});
	return {
		success: true,
		text,
		data: {
			actionName: "ATTACHMENT",
			action: "save_as_document",
			documentId: stored.clientDocumentId,
			fragmentCount: stored.fragmentCount,
			attachmentIds: params.records.map((record) => record.attachment.id),
		},
	};
}

export const readAttachmentAction: Action = {
	name: "ATTACHMENT",
	contexts: ["files", "media", "messaging", "documents"],
	roleGate: { minRole: "ADMIN" },
	similes: [
		"READ_ATTACHMENT",
		"SAVE_ATTACHMENT_AS_DOCUMENT",
		"OPEN_ATTACHMENT",
		"INSPECT_ATTACHMENT",
		"READ_URL",
		"OPEN_URL",
		"READ_WEBPAGE",
	],
	description:
		"Attachment operations. Use action=read to read current or recent attachments/link previews using extracted text, transcripts, page content, or media descriptions. Use action=save_as_document to store readable attachment content in the document store.",
	suppressPostActionContinuation: true,
	validate: async (runtime, message) => {
		const params = message.content as Record<string, unknown>;
		const hasExplicitAttachment =
			readAttachmentId(params) !== null ||
			typeof message.content.attachmentId === "string" ||
			(message.content.attachments?.length ?? 0) > 0;

		const attachments = await listConversationAttachments(runtime, message);
		return hasExplicitAttachment || attachments.length > 0;
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
			const action = readAttachmentActionKind(params, message);
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
						actions: ["ATTACHMENT_READ_FAILED"],
						source: message.content.source,
					});
				}
				return {
					success: false,
					text: fallback,
					data: { actionName: "ATTACHMENT", action },
				};
			}

			const hasContent = hasReadableContent(records);
			const storedContent = hasContent ? contentForRecords(records) : "";
			if (action === "save_as_document") {
				return saveAttachmentAsDocument({
					runtime,
					message: messageWithParams,
					records,
					content: storedContent,
					actionParams: params,
					callback,
				});
			}

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
					actions: ["ATTACHMENT_READ_SUCCESS"],
					source: messageWithParams.content.source,
				});
			}

			return {
				success: true,
				text: visibleText,
				data: {
					actionName: "ATTACHMENT",
					action: "read",
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
					actions: ["ATTACHMENT_READ_FAILED"],
					source: message.content.source,
				});
			}
			return {
				success: false,
				text: "Failed to read attachment",
				error: errorMessage,
				data: { actionName: "ATTACHMENT" },
			};
		}
	},
	parameters: [
		{
			name: "action",
			description: "Attachment operation: read or save_as_document.",
			required: false,
			schema: { type: "string" as const, enum: [...ATTACHMENT_ACTIONS] },
		},
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
	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "What does the PDF I just sent you say?",
					source: "chat",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Reading the attachment.",
					actions: ["ATTACHMENT"],
					thought:
						"User refers to a recently-attached file; ATTACHMENT action=read auto-selects the latest attachment when no id is given.",
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Open the link I shared above and summarise it.",
					source: "chat",
				},
			},
			{
				name: "{{agentName}}",
				content: {
					text: "Reading the page.",
					actions: ["ATTACHMENT"],
					thought:
						"Link previews are stored as attachments; ATTACHMENT action=read pulls the extracted text and answers the user's summary request.",
				},
			},
		],
	],
};

export default readAttachmentAction;
