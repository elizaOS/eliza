/** Publishes message bodies and attachments through atomic content-segment storage, rejecting oversized writes when the adapter lacks that capability. */
import { ElizaError } from "../../errors";
import {
	canonicalAttachmentText,
	MESSAGE_CONTENT_PARENT_INLINE_MAX_BYTES,
} from "../../features/messaging/content-segments";
import type { Content, IAgentRuntime, Memory, UUID } from "../../types";

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
