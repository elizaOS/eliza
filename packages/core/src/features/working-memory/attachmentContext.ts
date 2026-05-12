import {
	ContentType,
	type IAgentRuntime,
	type Media,
	type Memory,
	ModelType,
} from "../../types/index.ts";

type AttachmentWithInlineData = Media & {
	_data?: string;
	_mimeType?: string;
	_createdAt?: number;
};

type ReadAttachmentResult = {
	attachment: AttachmentWithInlineData;
	content: string;
	autoSelected: boolean;
};

function attachmentLocator(attachment: Media): string {
	return attachment.title?.trim() || attachment.url || attachment.id;
}

function isUnreadableFallbackDescription(value: string): boolean {
	return [
		"An image attachment (recognition failed)",
		"An audio/video attachment (transcription failed)",
		"User-uploaded audio/video attachment (no transcription available)",
		"Could not process video attachment because the required service is not available.",
		"A PDF document that could not be converted to text",
		"A plaintext document that could not be retrieved",
		"A generic attachment",
		"A video attachment",
	].includes(value.trim());
}

function attachmentStoredContent(attachment: Media): string {
	return [attachment.text, attachment.description]
		.filter(
			(value): value is string =>
				typeof value === "string" &&
				value.trim().length > 0 &&
				!isUnreadableFallbackDescription(value),
		)
		.join("\n\n")
		.trim();
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
	let response: unknown;
	try {
		response = await runtime.useModel(ModelType.IMAGE_DESCRIPTION, {
			prompt: "Describe this attachment so an agent can reference it later.",
			imageUrl,
		});
	} catch (error) {
		runtime.logger?.warn?.(
			{
				src: "core:clipboard:attachment-context",
				attachmentId: attachment.id,
				error: error instanceof Error ? error.message : String(error),
			},
			"Image attachment description failed",
		);
		return "";
	}
	if (typeof response === "string") {
		try {
			const parsed = JSON.parse(response) as Record<string, unknown>;
			const value =
				(typeof parsed.text === "string" ? parsed.text : "") ||
				(typeof parsed.description === "string" ? parsed.description : "");
			return value.trim();
		} catch {
			return String(response).trim();
		}
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

async function readableAttachmentContent(
	runtime: IAgentRuntime,
	attachment: AttachmentWithInlineData,
): Promise<string> {
	let content = attachmentStoredContent(attachment);
	if (!content && attachment.contentType === ContentType.IMAGE) {
		content = await describeImageAttachment(runtime, attachment);
	}
	return content;
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
	_runtime: IAgentRuntime,
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
	for (const attachment of attachments) {
		if (text.includes(attachment.id)) {
			return attachment.id;
		}
		const locator = attachmentLocator(attachment);
		if (locator && text.toLowerCase().includes(locator.toLowerCase())) {
			return attachment.id;
		}
	}
	return null;
}

export async function readAttachmentRecord(
	runtime: IAgentRuntime,
	message: Memory,
	attachmentId?: string | null,
): Promise<ReadAttachmentResult | null> {
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
	return {
		attachment,
		content: await readableAttachmentContent(runtime, attachment),
		autoSelected: !attachmentId?.trim(),
	};
}

export async function readAttachmentRecords(
	runtime: IAgentRuntime,
	message: Memory,
	attachmentId?: string | null,
): Promise<ReadAttachmentResult[]> {
	if (attachmentId?.trim()) {
		const record = await readAttachmentRecord(runtime, message, attachmentId);
		return record ? [record] : [];
	}

	const currentAttachments = (message.content.attachments ??
		[]) as AttachmentWithInlineData[];
	if (currentAttachments.length > 0) {
		const createdAt = message.createdAt ?? Date.now();
		return Promise.all(
			currentAttachments.map(async (attachment) => ({
				attachment: { ...attachment, _createdAt: createdAt },
				content: await readableAttachmentContent(runtime, attachment),
				autoSelected: true,
			})),
		);
	}

	const record = await readAttachmentRecord(runtime, message);
	return record ? [record] : [];
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
