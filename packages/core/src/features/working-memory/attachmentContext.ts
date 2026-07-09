/**
 * Attachment-reading helpers behind the ATTACHMENT action of the working-memory
 * capability. Gathers the attachments visible in the current conversation window
 * (the current message plus the recent-message history, deduped by id and ordered
 * newest-first), decides which one an untargeted request refers to (explicit
 * id/locator match, or the sole attachment), and materializes readable content
 * for each — stored extracted text or description, falling back to an on-demand
 * vision description that reuses the shared content-addressed image cache.
 * Consumed by readAttachmentAction.ts; the `_data`/`_mimeType`/`_createdAt` fields
 * are inline-transport and ordering extensions carried alongside `Media`.
 */
import { buildAccessContext } from "../../access-context.ts";
import {
	parseArtifactShareGrants,
	resolveArtifactDisclosure,
	selectDisclosedArtifactUrl,
} from "../../access-control/artifact-disclosure.ts";
import { describeImageCached } from "../../media/index.ts";
import {
	type AccessContext,
	ContentType,
	type IAgentRuntime,
	type Media,
	type Memory,
	type MemoryScope,
	type UUID,
} from "../../types/index.ts";

type AttachmentWithInlineData = Media & {
	_data?: string;
	_mimeType?: string;
	_createdAt?: number;
	redacted?: true;
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

const MEMORY_SCOPES: ReadonlySet<string> = new Set<MemoryScope>([
	"global",
	"shared",
	"room",
	"private",
	"owner-private",
	"user-private",
	"agent-private",
]);

function attachmentMessageScope(memory: Memory): MemoryScope {
	const rawScope = (memory.metadata as Record<string, unknown> | undefined)
		?.scope;
	if (rawScope === undefined) return "room";
	return typeof rawScope === "string" && MEMORY_SCOPES.has(rawScope)
		? (rawScope as MemoryScope)
		: "owner-private";
}

async function buildAttachmentAccessContext(
	runtime: IAgentRuntime,
	message: Memory,
): Promise<AccessContext | undefined> {
	const agentId = runtime.agentId as UUID | undefined;
	if (!agentId || !message.entityId || message.entityId === agentId) {
		return undefined;
	}
	try {
		return await buildAccessContext(runtime, message);
	} catch (error) {
		// error-policy:J3 access-context resolution is an auth boundary input;
		// failure degrades to requester-only USER disclosure, never unrestricted.
		runtime.logger?.warn(
			{
				src: "attachment-context",
				error: error instanceof Error ? error.message : String(error),
			},
			"Access-context resolution failed; falling back to requester-only attachment disclosure",
		);
		return { requesterEntityId: message.entityId as UUID };
	}
}

function selectAttachmentForRequester(
	memory: Memory,
	attachment: AttachmentWithInlineData,
	accessContext: AccessContext | undefined,
	agentId: UUID | undefined,
): AttachmentWithInlineData | null {
	if (!accessContext || !agentId) return attachment;
	const metadata = memory.metadata as Record<string, unknown> | undefined;
	const scopedTo = metadata?.scopedToEntityId;
	const addedBy = metadata?.addedBy;
	const disclosure = resolveArtifactDisclosure(
		{
			scope: attachmentMessageScope(memory),
			scopedEntityId:
				typeof scopedTo === "string"
					? (scopedTo as UUID)
					: typeof addedBy === "string"
						? (addedBy as UUID)
						: memory.entityId,
			grants: parseArtifactShareGrants(metadata),
		},
		accessContext,
		agentId,
	);
	const selected = selectDisclosedArtifactUrl(disclosure, {
		fullUrl: attachment.url,
		redactedUrl: attachment.redactedUrl,
	});
	if (!selected) return null;
	if (!selected.redacted) return attachment;
	const {
		description: _description,
		text: _text,
		thumbnailUrl: _thumbnailUrl,
		_data,
		_mimeType,
		notProcessed: _notProcessed,
		...rest
	} = attachment;
	return {
		...rest,
		url: selected.url,
		redacted: true,
	};
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
	// Reuse the shared content-addressed cache — the same image described during
	// inbound processing is reused here instead of re-running the vision model.
	const described = await describeImageCached(
		runtime,
		imageUrl,
		"Describe this attachment so an agent can reference it later.",
	);
	return (described?.text || described?.description || "").trim();
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
	options: { maxLookback?: number } = {},
): Promise<AttachmentWithInlineData[]> {
	const currentMessageAttachments = (message.content.attachments ??
		[]) as AttachmentWithInlineData[];
	const conversationLength =
		typeof options.maxLookback === "number"
			? Math.min(runtime.getConversationLength(), options.maxLookback)
			: runtime.getConversationLength();
	const accessContext = await buildAttachmentAccessContext(runtime, message);
	const agentId = runtime.agentId as UUID | undefined;
	const recentMessages = await runtime.getMemories({
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
		return currentMessageAttachments
			.map((attachment) =>
				selectAttachmentForRequester(
					message,
					{ ...attachment, _createdAt: message.createdAt ?? Date.now() },
					accessContext,
					agentId,
				),
			)
			.filter((attachment): attachment is AttachmentWithInlineData =>
				Boolean(attachment),
			);
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
		const selected = selectAttachmentForRequester(
			message,
			attachment,
			accessContext,
			agentId,
		);
		if (selected) rememberAttachment(selected, message.createdAt ?? Date.now());
	}

	for (const recentMessage of recentMessages) {
		const messageAttachments = (recentMessage.content.attachments ??
			[]) as AttachmentWithInlineData[];
		const createdAt = recentMessage.createdAt ?? Date.now();
		for (const attachment of messageAttachments) {
			const selected = selectAttachmentForRequester(
				recentMessage,
				attachment,
				accessContext,
				agentId,
			);
			if (selected) rememberAttachment(selected, createdAt);
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
		const attachments = await listConversationAttachments(runtime, message);
		const currentIds = new Set(
			currentAttachments.map((attachment) => attachment.id),
		);
		return Promise.all(
			attachments
				.filter((attachment) => currentIds.has(attachment.id))
				.map(async (attachment) => ({
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
