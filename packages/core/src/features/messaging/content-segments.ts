/**
 * Projects oversized stored-message and attachment text into immutable UTF-8
 * memory segments and reconstructs one bounded byte page from adapter-selected
 * rows. Parent descriptors are content-free commit points; segment identifiers
 * are deterministic for one message, source revision, and ordinal.
 */
import { v5 as uuidv5 } from "uuid";
import {
	artifactDisclosureRecordFromMemory,
	resolveArtifactDisclosure,
} from "../../access-control/artifact-disclosure";
import { ElizaError } from "../../errors";
import type {
	AccessContext,
	Content,
	ContentValue,
	Media,
	Memory,
	MessageContentSourceSelector,
	UUID,
} from "../../types";
import { createHash } from "../../utils/crypto-compat";

export const MESSAGE_CONTENT_SEGMENT_VERSION = 1 as const;
export const MESSAGE_CONTENT_SEGMENT_MAX_BYTES = 64 * 1024;
export const MESSAGE_CONTENT_PARENT_INLINE_MAX_BYTES = 64 * 1024;
export const MESSAGE_CONTENT_READ_MAX_SEGMENTS = 3;
export const MESSAGE_CONTENT_SEGMENT_TABLE = "message_content_segments";

export type MessageContentSourceKind = "message-text" | "attachment-text";

export interface MessageContentSourceDescriptor {
	[key: string]: ContentValue;
	kind: MessageContentSourceKind;
	storage: "segments";
	version: typeof MESSAGE_CONTENT_SEGMENT_VERSION;
	revision: string;
	sha256: string;
	byteLength: number;
	segmentCount: number;
	/** Hash only: raw attachment identifiers never enter segment rows. */
	attachmentIdHash?: string;
}

export interface MessageContentSegmentMetadata {
	type: "message-content-segment";
	messageId: UUID;
	sourceKind: MessageContentSourceKind;
	attachmentIdHash?: string;
	sourceRevision: string;
	segmentVersion: typeof MESSAGE_CONTENT_SEGMENT_VERSION;
	ordinal: number;
	byteStart: number;
	byteEnd: number;
	segmentSha256: string;
	timestamp: number;
}

export interface MessageContentProjection {
	content: Content;
	segments: Memory[];
}

interface ReconstructedMessageContentPage {
	text: string;
	start: number;
	end: number;
	total: number;
	revision: string;
	sourceSha256: string;
	sliceSha256: string;
	returnedSegments: number;
	returnedBytes: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
// elizaOS IDs are UUID-shaped but may be deterministically derived with a
// non-RFC version nibble. They are valid database identities, but the `uuid`
// package rejects them as v5 namespaces. Keep one RFC namespace and include
// the parent identity in the name so every accepted elizaOS UUID remains a
// deterministic, collision-isolated segment owner.
const MESSAGE_CONTENT_SEGMENT_NAMESPACE =
	"6ba7b811-9dad-11d1-80b4-00c04fd430c8";

function bytes(value: string): Uint8Array {
	return encoder.encode(value);
}

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

export function hashAttachmentIdForLocator(attachmentId: string): string {
	return sha256(`attachment-id\0${attachmentId}`);
}

function isUnreadableAttachmentDescription(value: string): boolean {
	return [
		"An image attachment (recognition failed)",
		"An image attachment (image bytes unavailable)",
		"An audio/video attachment (transcription failed)",
		"User-uploaded audio/video attachment (no transcription available)",
		"Could not process video attachment because the required service is not available.",
		"A PDF document that could not be converted to text",
		"A plaintext document that could not be retrieved",
		"A generic attachment",
		"A video attachment",
	].includes(value.trim());
}

/** Exact text historically exposed by ATTACHMENT reads, without fallback prose. */
export function canonicalAttachmentText(attachment: Media): string {
	return [attachment.text, attachment.description]
		.filter(
			(value): value is string =>
				typeof value === "string" &&
				value.trim().length > 0 &&
				!isUnreadableAttachmentDescription(value),
		)
		.join("\n\n")
		.trim();
}

function safeUtf8End(source: Uint8Array, start: number): number {
	let end = Math.min(start + MESSAGE_CONTENT_SEGMENT_MAX_BYTES, source.length);
	while (end > start && end < source.length && (source[end] & 0xc0) === 0x80) {
		end--;
	}
	if (end === start) {
		throw new ElizaError(
			"Unable to construct a complete UTF-8 content segment",
			{
				code: "MESSAGE_CONTENT_INVALID_UTF8",
			},
		);
	}
	return end;
}

function sourceSegmentId(args: {
	messageId: UUID;
	kind: MessageContentSourceKind;
	revision: string;
	ordinal: number;
	attachmentHash?: string;
}): UUID {
	return uuidv5(
		[
			"message-content-segment-v1",
			args.messageId,
			args.kind,
			args.attachmentHash ?? "message",
			args.revision,
			String(args.ordinal),
		].join(":"),
		MESSAGE_CONTENT_SEGMENT_NAMESPACE,
	) as UUID;
}

function buildSource(args: {
	text: string;
	message: Memory & { id: UUID };
	kind: MessageContentSourceKind;
	attachmentHash?: string;
}): { descriptor: MessageContentSourceDescriptor; segments: Memory[] } {
	const source = bytes(args.text);
	const digest = sha256(source);
	const revision = `rev:${digest}`;
	const descriptor: MessageContentSourceDescriptor = {
		kind: args.kind,
		storage: "segments",
		version: MESSAGE_CONTENT_SEGMENT_VERSION,
		revision,
		sha256: digest,
		byteLength: source.length,
		segmentCount: Math.ceil(source.length / MESSAGE_CONTENT_SEGMENT_MAX_BYTES),
		...(args.attachmentHash ? { attachmentIdHash: args.attachmentHash } : {}),
	};
	const segments: Memory[] = [];
	for (let start = 0, ordinal = 0; start < source.length; ordinal++) {
		const end = safeUtf8End(source, start);
		const segmentBytes = source.subarray(start, end);
		const metadata: MessageContentSegmentMetadata = {
			type: "message-content-segment",
			messageId: args.message.id,
			sourceKind: args.kind,
			...(args.attachmentHash ? { attachmentIdHash: args.attachmentHash } : {}),
			sourceRevision: revision,
			segmentVersion: MESSAGE_CONTENT_SEGMENT_VERSION,
			ordinal,
			byteStart: start,
			byteEnd: end,
			segmentSha256: sha256(segmentBytes),
			timestamp: args.message.createdAt ?? Date.now(),
		};
		segments.push({
			id: sourceSegmentId({
				messageId: args.message.id,
				kind: args.kind,
				revision,
				ordinal,
				attachmentHash: args.attachmentHash,
			}),
			agentId: args.message.agentId,
			roomId: args.message.roomId,
			entityId: args.message.entityId,
			worldId: args.message.worldId,
			content: { text: decoder.decode(segmentBytes) },
			metadata: metadata as unknown as Memory["metadata"],
		});
		start = end;
	}
	if (segments.length !== descriptor.segmentCount) {
		// UTF-8 boundary retreat can add a segment beyond the byte-length ceiling.
		descriptor.segmentCount = segments.length;
	}
	return { descriptor, segments };
}

function attachmentDescriptor(
	value: Media,
): MessageContentSourceDescriptor | null {
	const candidate = (value as Media & { textSource?: unknown }).textSource;
	return isMessageContentSourceDescriptor(candidate, "attachment-text")
		? candidate
		: null;
}

/** Builds the small parent and every immutable segment before publication. */
export function buildMessageContentProjection(
	message: Memory & { id: UUID },
): MessageContentProjection {
	const segments: Memory[] = [];
	const content: Content = { ...message.content };
	const messageText = content.text;
	if (
		typeof messageText === "string" &&
		bytes(messageText).length > MESSAGE_CONTENT_PARENT_INLINE_MAX_BYTES
	) {
		const source = buildSource({
			text: messageText,
			message,
			kind: "message-text",
		});
		segments.push(...source.segments);
		delete content.text;
		content.messageTextSource = source.descriptor;
	}
	if (Array.isArray(content.attachments)) {
		content.attachments = content.attachments.map((attachment) => {
			const canonical = canonicalAttachmentText(attachment);
			if (
				canonical.length === 0 ||
				bytes(canonical).length <= MESSAGE_CONTENT_PARENT_INLINE_MAX_BYTES
			) {
				return { ...attachment };
			}
			const hash = hashAttachmentIdForLocator(attachment.id);
			const source = buildSource({
				text: canonical,
				message,
				kind: "attachment-text",
				attachmentHash: hash,
			});
			segments.push(...source.segments);
			const projected = { ...attachment } as Media & {
				textSource?: MessageContentSourceDescriptor;
			};
			delete projected.text;
			delete projected.description;
			projected.textSource = source.descriptor;
			return projected;
		});
	}
	return { content, segments };
}

export function isMessageContentSourceDescriptor(
	value: unknown,
	expectedKind?: MessageContentSourceKind,
): value is MessageContentSourceDescriptor {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	return (
		(record.kind === "message-text" || record.kind === "attachment-text") &&
		(expectedKind === undefined || record.kind === expectedKind) &&
		record.storage === "segments" &&
		record.version === MESSAGE_CONTENT_SEGMENT_VERSION &&
		typeof record.revision === "string" &&
		/^rev:[a-f0-9]{64}$/u.test(record.revision) &&
		typeof record.sha256 === "string" &&
		/^[a-f0-9]{64}$/u.test(record.sha256) &&
		Number.isSafeInteger(record.byteLength) &&
		(record.byteLength as number) > MESSAGE_CONTENT_PARENT_INLINE_MAX_BYTES &&
		Number.isSafeInteger(record.segmentCount) &&
		(record.segmentCount as number) > 0 &&
		(record.kind !== "attachment-text" ||
			(typeof record.attachmentIdHash === "string" &&
				/^[a-f0-9]{64}$/u.test(record.attachmentIdHash)))
	);
}

export function messageTextSourceDescriptor(
	content: Content,
): MessageContentSourceDescriptor | null {
	return isMessageContentSourceDescriptor(
		content.messageTextSource,
		"message-text",
	)
		? content.messageTextSource
		: null;
}

export function attachmentTextSourceDescriptor(
	attachment: Media,
): MessageContentSourceDescriptor | null {
	return attachmentDescriptor(attachment);
}

/** Finds exactly one committed source descriptor; duplicates fail closed. */
export function resolveMessageContentSourceDescriptor(
	content: Content,
	selector: MessageContentSourceSelector,
): MessageContentSourceDescriptor | null {
	if (selector.kind === "message-text") {
		return messageTextSourceDescriptor(content);
	}
	if (!/^[a-f0-9]{64}$/u.test(selector.attachmentIdHash ?? "")) {
		throw new ElizaError("Attachment source selector is invalid", {
			code: "ATTACHMENT_CONTENT_INVALID_REFERENCE",
		});
	}
	const matches = (content.attachments ?? [])
		.map(attachmentTextSourceDescriptor)
		.filter(
			(descriptor): descriptor is MessageContentSourceDescriptor =>
				descriptor?.attachmentIdHash === selector.attachmentIdHash,
		);
	if (matches.length > 1) {
		throw new ElizaError("Attachment source descriptor is ambiguous", {
			code: "ATTACHMENT_CONTENT_CORRUPT",
		});
	}
	return matches[0] ?? null;
}

/**
 * Authorizes a parent at every page read. Segment rows inherit no independent
 * visibility: a missing participant or a redacted/denied disclosure cannot
 * return full source text.
 */
export function authorizeMessageContentRead(args: {
	parent: Memory;
	authorizedRoomId: UUID;
	requester: AccessContext;
	agentId: UUID;
	participantCurrent: boolean;
	selector: MessageContentSourceSelector;
}): boolean {
	if (
		args.parent.agentId !== args.agentId ||
		args.parent.roomId !== args.authorizedRoomId ||
		!args.participantCurrent
	) {
		return false;
	}
	const disclosureRecord = artifactDisclosureRecordFromMemory(args.parent);
	const metadata = args.parent.metadata as Record<string, unknown> | undefined;
	const disclosure = resolveArtifactDisclosure(
		metadata?.scope === undefined
			? { ...disclosureRecord, scope: "room" }
			: disclosureRecord,
		args.requester,
		args.agentId,
	);
	if (disclosure !== "full") return false;
	if (args.selector.kind === "message-text") return true;
	if (
		resolveMessageContentSourceDescriptor(
			args.parent.content,
			args.selector,
		) !== null
	) {
		return true;
	}
	return (args.parent.content.attachments ?? []).some(
		(attachment) =>
			hashAttachmentIdForLocator(attachment.id) ===
			args.selector.attachmentIdHash,
	);
}

export function messageContentRequiresSegments(content: Content): boolean {
	if (messageTextSourceDescriptor(content)) return true;
	return (content.attachments ?? []).some((attachment) =>
		Boolean(attachmentTextSourceDescriptor(attachment)),
	);
}

export function collectMessageContentSegmentIds(
	messageId: UUID,
	content: Content,
): UUID[] {
	const descriptors = [
		messageTextSourceDescriptor(content),
		...(content.attachments ?? []).map(attachmentTextSourceDescriptor),
	].filter(
		(descriptor): descriptor is MessageContentSourceDescriptor =>
			descriptor !== null,
	);
	return descriptors.flatMap((descriptor) =>
		Array.from({ length: descriptor.segmentCount }, (_, ordinal) =>
			sourceSegmentId({
				messageId,
				kind: descriptor.kind,
				revision: descriptor.revision,
				ordinal,
				attachmentHash: descriptor.attachmentIdHash,
			}),
		),
	);
}

function safeInteger(value: unknown): number | null {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

/** Validates adapter-selected rows and returns exactly one UTF-8 byte page. */
export function readMessageContentProjection(args: {
	descriptor: MessageContentSourceDescriptor;
	segments: Memory[];
	messageId: UUID;
	offset: number;
	limit: number;
}): ReconstructedMessageContentPage {
	if (
		!Number.isSafeInteger(args.offset) ||
		args.offset < 0 ||
		!Number.isSafeInteger(args.limit) ||
		args.limit < 1 ||
		args.limit > MESSAGE_CONTENT_SEGMENT_MAX_BYTES ||
		args.offset > args.descriptor.byteLength
	) {
		throw new ElizaError("Message content range is invalid", {
			code: "MESSAGE_CONTENT_INVALID_RANGE",
			context: { messageId: args.messageId },
		});
	}
	if (args.segments.length > MESSAGE_CONTENT_READ_MAX_SEGMENTS) {
		throw new ElizaError("Message content read exceeded bounded row count", {
			code: "MESSAGE_CONTENT_CORRUPT",
			context: { messageId: args.messageId, rows: args.segments.length },
		});
	}
	const ordered = [...args.segments].sort((left, right) => {
		const leftStart = safeInteger(
			(left.metadata as Record<string, unknown> | undefined)?.byteStart,
		);
		const rightStart = safeInteger(
			(right.metadata as Record<string, unknown> | undefined)?.byteStart,
		);
		return (leftStart ?? -1) - (rightStart ?? -1);
	});
	let previousEnd: number | undefined;
	let previousOrdinal: number | undefined;
	for (const segment of ordered) {
		const metadata = (segment.metadata ?? {}) as Record<string, unknown>;
		const start = safeInteger(metadata.byteStart);
		const end = safeInteger(metadata.byteEnd);
		const ordinal = safeInteger(metadata.ordinal);
		const text = segment.content.text;
		if (
			metadata.type !== "message-content-segment" ||
			metadata.segmentVersion !== MESSAGE_CONTENT_SEGMENT_VERSION ||
			metadata.messageId !== args.messageId ||
			metadata.sourceKind !== args.descriptor.kind ||
			metadata.sourceRevision !== args.descriptor.revision ||
			metadata.attachmentIdHash !== args.descriptor.attachmentIdHash ||
			start === null ||
			end === null ||
			end <= start ||
			ordinal === null ||
			typeof text !== "string" ||
			bytes(text).length !== end - start ||
			typeof metadata.segmentSha256 !== "string" ||
			sha256(text) !== metadata.segmentSha256 ||
			(previousEnd !== undefined && start !== previousEnd) ||
			(previousOrdinal !== undefined && ordinal !== previousOrdinal + 1)
		) {
			throw new ElizaError("Message content segments are corrupt", {
				code: "MESSAGE_CONTENT_CORRUPT",
				context: { messageId: args.messageId, ordinal },
			});
		}
		previousEnd = end;
		previousOrdinal = ordinal;
	}
	if (args.offset === args.descriptor.byteLength) {
		return {
			text: "",
			start: args.offset,
			end: args.offset,
			total: args.descriptor.byteLength,
			revision: args.descriptor.revision,
			sourceSha256: args.descriptor.sha256,
			sliceSha256: sha256(""),
			returnedSegments: 0,
			returnedBytes: 0,
		};
	}
	if (ordered.length === 0) {
		throw new ElizaError("Message content range is missing", {
			code: "MESSAGE_CONTENT_CORRUPT",
			context: { messageId: args.messageId, offset: args.offset },
		});
	}
	const firstStart = safeInteger(
		(ordered[0].metadata as Record<string, unknown>).byteStart,
	);
	if (firstStart === null || firstStart > args.offset) {
		throw new ElizaError("Message content range prefix is missing", {
			code: "MESSAGE_CONTENT_CORRUPT",
			context: { messageId: args.messageId, offset: args.offset },
		});
	}
	const combined = bytes(ordered.map((row) => row.content.text ?? "").join(""));
	const localStart = args.offset - firstStart;
	if (
		localStart < 0 ||
		localStart >= combined.length ||
		(combined[localStart] & 0xc0) === 0x80
	) {
		throw new ElizaError("Message content offset splits a UTF-8 sequence", {
			code: "MESSAGE_CONTENT_INVALID_UTF8_BOUNDARY",
			context: { messageId: args.messageId, offset: args.offset },
		});
	}
	const requestedEnd = Math.min(
		args.offset + args.limit,
		args.descriptor.byteLength,
	);
	if (firstStart + combined.length < requestedEnd) {
		throw new ElizaError("Message content range suffix is missing", {
			code: "MESSAGE_CONTENT_CORRUPT",
			context: {
				messageId: args.messageId,
				availableEnd: firstStart + combined.length,
				requestedEnd,
			},
		});
	}
	let localEnd = Math.min(
		localStart + requestedEnd - args.offset,
		combined.length,
	);
	while (
		localEnd > localStart &&
		localEnd < combined.length &&
		(combined[localEnd] & 0xc0) === 0x80
	) {
		localEnd--;
	}
	if (localEnd === localStart) {
		throw new ElizaError("Message content limit splits a UTF-8 sequence", {
			code: "MESSAGE_CONTENT_INVALID_UTF8_BOUNDARY",
			context: { messageId: args.messageId, offset: args.offset },
		});
	}
	const pageBytes = combined.subarray(localStart, localEnd);
	const end = args.offset + pageBytes.length;
	let text: string;
	try {
		text = decoder.decode(pageBytes);
	} catch (cause) {
		throw new ElizaError("Message content page is not valid UTF-8", {
			code: "MESSAGE_CONTENT_INVALID_UTF8_BOUNDARY",
			cause,
			context: { messageId: args.messageId, offset: args.offset },
		});
	}
	return {
		text,
		start: args.offset,
		end,
		total: args.descriptor.byteLength,
		revision: args.descriptor.revision,
		sourceSha256: args.descriptor.sha256,
		sliceSha256: sha256(pageBytes),
		returnedSegments: ordered.length,
		returnedBytes: pageBytes.length,
	};
}
