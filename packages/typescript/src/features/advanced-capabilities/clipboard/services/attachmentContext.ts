import {
	ContentType,
	type IAgentRuntime,
	type Media,
	type Memory,
	ModelType,
	parseKeyValueXml,
} from "../../../../types/index.ts";

type AttachmentWithInlineData = Media & {
	_data?: string;
	_mimeType?: string;
	_createdAt?: number;
};

function attachmentLocator(attachment: Media): string {
	return attachment.title?.trim() || attachment.url || attachment.id;
}

function attachmentStoredContent(attachment: Media): string {
	return [attachment.text, attachment.description]
		.filter(
			(value): value is string =>
				typeof value === "string" && value.trim().length > 0,
		)
		.join("\n\n")
		.trim();
}

function selectionPrompt(messageText: string, attachments: Media[]): string {
	const choices = attachments
		.map(
			(attachment) =>
				`- ${attachment.id}: ${attachmentLocator(attachment)} (${attachment.contentType ?? "unknown"})`,
		)
		.join("\n");
	return [
		"Select the attachment ID the user is asking about.",
		"",
		`User message: ${messageText}`,
		"",
		"Available attachments:",
		choices,
		"",
		"Respond with XML:",
		"<response><attachmentId>attachment-id</attachmentId></response>",
	].join("\n");
}

async function describeImageAttachment(
	runtime: IAgentRuntime,
	attachment: AttachmentWithInlineData,
): Promise<string> {
	let imageUrl: string | null = null;
	if (
		typeof attachment._data === "string" &&
		typeof attachment._mimeType === "string"
	) {
		imageUrl = `data:${attachment._mimeType};base64,${attachment._data}`;
	} else if (/^(http|https):\/\//.test(attachment.url)) {
		imageUrl = attachment.url;
	}
	if (!imageUrl) {
		return "";
	}
	const response = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
		prompt: "Describe this attachment so an agent can reference it later.",
		imageUrl,
	});
	if (typeof response === "string") {
		const parsed = parseKeyValueXml(response) as Record<string, unknown> | null;
		if (parsed) {
			const value =
				(typeof parsed.text === "string" ? parsed.text : "") ||
				(typeof parsed.description === "string" ? parsed.description : "");
			return value.trim();
		}
		return String(response).trim();
	}
	if (
		response &&
		typeof response === "object" &&
		"description" in response &&
		typeof response.description === "string"
	) {
		return response.description.trim();
	}
	return "";
}

export async function listConversationAttachments(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<AttachmentWithInlineData[]> {
	const currentMessageAttachments = (message.content.attachments ??
		[]) as AttachmentWithInlineData[];
	const conversationLength = runtime.getConversationLength?.() ?? 20;
	const recentMessages = await runtime.getMemories?.({
		roomId: message.roomId,
		count: conversationLength,
		unique: false,
		tableName: "messages",
	});

	if (
		!recentMessages ||
		!Array.isArray(recentMessages) ||
		recentMessages.length === 0
	) {
		return currentMessageAttachments.map((attachment) => ({
			...attachment,
			_createdAt: message.createdAt ?? Date.now(),
		}));
	}

	const attachmentsById = new Map<string, AttachmentWithInlineData>();

	const rememberAttachment = (
		attachment: AttachmentWithInlineData,
		createdAt: number,
	) => {
		const existing = attachmentsById.get(attachment.id);
		if (existing && (existing._createdAt ?? 0) >= createdAt) {
			return;
		}
		attachmentsById.set(attachment.id, {
			...attachment,
			_createdAt: createdAt,
		});
	};

	for (const attachment of currentMessageAttachments) {
		rememberAttachment(attachment, message.createdAt ?? Date.now());
	}

	for (const recentMessage of recentMessages) {
		const messageAttachments = (recentMessage.content.attachments ??
			[]) as AttachmentWithInlineData[];
		const createdAt = recentMessage.createdAt ?? Date.now();
		for (const attachment of messageAttachments) {
			rememberAttachment(attachment, createdAt);
		}
	}

	return Array.from(attachmentsById.values()).sort(
		(left, right) => (right._createdAt ?? 0) - (left._createdAt ?? 0),
	);
}

export async function resolveAttachmentSelection(
	runtime: IAgentRuntime,
	message: Memory,
	attachments: Media[],
): Promise<string | null> {
	const directId =
		typeof message.content.attachmentId === "string"
			? message.content.attachmentId.trim()
			: typeof message.content.id === "string"
				? message.content.id.trim()
				: "";
	if (directId) {
		return directId;
	}
	if (attachments.length === 1) {
		return attachments[0]?.id ?? null;
	}
	const text =
		typeof message.content.text === "string" ? message.content.text : "";
	if (!text.trim()) {
		return null;
	}
	const response = await runtime.useModel(ModelType.TEXT_SMALL, {
		prompt: selectionPrompt(text, attachments),
		stopSequences: [],
	});
	const parsed = parseKeyValueXml(String(response)) as Record<
		string,
		unknown
	> | null;
	const attachmentId = parsed?.attachmentId;
	if (typeof attachmentId === "string" && attachmentId.trim()) {
		return attachmentId.trim();
	}
	return null;
}

export async function readAttachmentRecord(
	runtime: IAgentRuntime,
	message: Memory,
	attachmentId?: string | null,
): Promise<{
	attachment: AttachmentWithInlineData;
	content: string;
	autoSelected: boolean;
} | null> {
	const attachments = await listConversationAttachments(runtime, message);
	if (attachments.length === 0) {
		return null;
	}
	const selectedId =
		attachmentId?.trim() ||
		(await resolveAttachmentSelection(runtime, message, attachments));
	if (!selectedId) {
		return null;
	}
	const attachment = attachments.find((item) => item.id === selectedId);
	if (!attachment) {
		return null;
	}
	let content = attachmentStoredContent(attachment);
	if (!content && attachment.contentType === ContentType.IMAGE) {
		content = await describeImageAttachment(runtime, attachment);
	}
	return {
		attachment,
		content,
		autoSelected: !attachmentId?.trim(),
	};
}

export function summarizeAttachment(attachment: Media): string {
	const storedContent = attachmentStoredContent(attachment);
	return [
		`ID: ${attachment.id}`,
		`Name: ${attachmentLocator(attachment)}`,
		`Type: ${attachment.contentType ?? "unknown"}`,
		`Source: ${attachment.source ?? "unknown"}`,
		`Stored content: ${storedContent ? "yes" : "no"}`,
	].join("\n");
}
