/** Publishes message bodies and attachments through atomic content-segment storage, rejecting oversized writes when the adapter lacks that capability. */
import { isDeepStrictEqual } from "node:util";
import { ElizaError } from "../errors";
import type { Content, IAgentRuntime, Memory, UUID } from "../types";
import {
	buildMessageContentProjection,
	canonicalAttachmentText,
	MESSAGE_CONTENT_PARENT_INLINE_MAX_BYTES,
	MESSAGE_CONTENT_SEGMENT_TABLE,
} from "./message-content-segments";

function contentNeedsNativeSegments(content: Content): boolean {
	const encoder = new TextEncoder();
	if (
		typeof content.text === "string" &&
		encoder.encode(content.text).length >
			MESSAGE_CONTENT_PARENT_INLINE_MAX_BYTES
	) {
		return true;
	}
	return (content.attachments ?? []).some(
		(attachment) =>
			encoder.encode(canonicalAttachmentText(attachment)).length >
			MESSAGE_CONTENT_PARENT_INLINE_MAX_BYTES,
		MESSAGE_CONTENT_SEGMENT_TABLE,
	);
}

export async function persistMessageMemory(
	runtime: IAgentRuntime,
	memory: Memory,
): Promise<UUID> {
	if (runtime.createMessageMemory) {
		return runtime.createMessageMemory(memory);
	}
	if (contentNeedsNativeSegments(memory.content)) {
		throw new ElizaError(
			"Runtime cannot atomically publish oversized message content",
			{
				code: "MESSAGE_CONTENT_SEGMENT_STORAGE_UNAVAILABLE",
				context: { messageId: memory.id ?? null },
			},
		);
	}
	return runtime.createMemory(memory, "messages");
}

/** Reuses only an exact, complete host-prepersisted ingress message; ordinary publication remains strict. */
export async function persistIncomingMessageMemory(
	runtime: IAgentRuntime,
	memory: Memory,
): Promise<UUID> {
	if (!memory.id) return persistMessageMemory(runtime, memory);
	const id = memory.id;
	const assertExisting = async (existing: Memory): Promise<UUID> => {
		const conflict = () =>
			new ElizaError(
				"Incoming message id is bound to different or incomplete content",
				{
					code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT",
					context: { messageId: id },
				},
			);
		if (
			existing.id !== id ||
			existing.agentId !== (memory.agentId ?? runtime.agentId) ||
			existing.roomId !== memory.roomId ||
			existing.entityId !== memory.entityId
		)
			throw conflict();
		// Legacy createMemory redacts text; native publication also redacts attachment text.
		const textRedacted = {
			...memory.content,
			...(typeof memory.content.text === "string"
				? { text: runtime.redactSecrets(memory.content.text) }
				: {}),
		};
		const allRedacted = {
			...textRedacted,
			...(memory.content.attachments
				? {
						attachments: memory.content.attachments.map((attachment) => ({
							...attachment,
							...(typeof attachment.text === "string"
								? { text: runtime.redactSecrets(attachment.text) }
								: {}),
							...(typeof attachment.description === "string"
								? { description: runtime.redactSecrets(attachment.description) }
								: {}),
						})),
					}
				: {}),
		};
		for (const content of [memory.content, textRedacted, allRedacted]) {
			if (isDeepStrictEqual(existing.content, content)) return id;
			const projection = buildMessageContentProjection({
				...memory,
				id,
				agentId: memory.agentId ?? runtime.agentId,
				content,
			});
			if (!isDeepStrictEqual(existing.content, projection.content)) continue;
			const expected = projection.segments;
			const rows = await runtime.getMemoriesByIds(
				expected.map((segment) => {
					if (!segment.id) throw conflict();
					return segment.id;
				}),
				MESSAGE_CONTENT_SEGMENT_TABLE,
			);
			const byId = new Map(rows.map((row) => [row.id, row]));
			if (
				expected.every((segment) => {
					const row = byId.get(segment.id);
					// Segment timestamps describe first publication, not source bytes.
					const { timestamp: _expectedTime, ...expectedMetadata } =
						segment.metadata ?? {};
					const { timestamp: _storedTime, ...storedMetadata } =
						row?.metadata ?? {};
					return (
						row &&
						row.agentId === segment.agentId &&
						row.roomId === segment.roomId &&
						row.entityId === segment.entityId &&
						isDeepStrictEqual(row.content, segment.content) &&
						isDeepStrictEqual(storedMetadata, expectedMetadata)
					);
				})
			)
				return id;
			throw conflict();
		}
		throw conflict();
	};
	const [existing] = await runtime.getMemoriesByIds([id], "messages");
	if (existing) return assertExisting(existing);
	try {
		return await persistMessageMemory(runtime, memory);
	} catch (error) {
		// error-policy:J1 Translate only a concurrent exact ingress publication into reuse.
		if (
			!(error instanceof ElizaError) ||
			error.code !== "MESSAGE_CONTENT_PUBLICATION_CONFLICT"
		)
			throw error;
		const [raced] = await runtime.getMemoriesByIds([id], "messages");
		if (!raced) throw error;
		return assertExisting(raced);
	}
}

export async function replaceStoredMessageContent(
	runtime: IAgentRuntime,
	messageId: UUID,
	content: Content,
): Promise<void> {
	if (runtime.replaceMessageMemoryContent) {
		await runtime.replaceMessageMemoryContent(messageId, content);
		return;
	}
	if (contentNeedsNativeSegments(content)) {
		throw new ElizaError(
			"Runtime cannot atomically replace oversized message content",
			{
				code: "MESSAGE_CONTENT_SEGMENT_STORAGE_UNAVAILABLE",
				context: { messageId },
			},
		);
	}
	await runtime.updateMemory({ id: messageId, content });
}
