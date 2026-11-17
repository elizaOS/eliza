/** Copies a complete, immutable prefix. It never processes copied messages as new turns. */
import { createHash } from "node:crypto";
import {
  type AgentRuntime,
  collectMessageContentSegmentIds,
  MESSAGE_CONTENT_SEGMENT_TABLE,
  type Memory,
  type MessageContentSegmentMetadata,
  messageContentSegmentId,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  getCompleteConversationMemories,
  readStoredMessageText,
} from "./conversation-message-service.ts";

export async function conversationForkSnapshot(
  runtime: AgentRuntime,
  roomId: UUID,
  messageId: string,
  targetRoomId: UUID,
  sourceConversationId: string,
  expectedText: string,
) {
  const all = await getCompleteConversationMemories(runtime, roomId);
  const boundary = all.findIndex((row) => row.id === messageId);
  if (
    boundary < 0 ||
    all[boundary].entityId === runtime.agentId ||
    all[boundary].content.source === "local_command"
  )
    throw Object.assign(new Error("Editable message not found"), {
      status: 404,
    });
  if (
    (await readStoredMessageText(
      runtime,
      all[boundary] as Memory & { id: UUID },
    )) !== expectedText
  )
    throw Object.assign(
      new Error("The selected message changed. Reload before editing."),
      { status: 409 },
    );
  const prefix = all.slice(0, boundary);
  const ids = new Map(
    prefix.map((row) => [
      row.id!,
      stringToUuid(`conversation-fork:${targetRoomId}:${row.id}`),
    ]),
  );
  const copies: Array<{ memory: Memory; tableName: string }> = [];
  for (const row of prefix) {
    const content = structuredClone(row.content);
    // Historical evidence stays historical. A copied request cannot recover or
    // dispatch a source turn through the durable idempotency mechanism.
    delete content.chatIdempotency;
    if (content.inReplyTo && ids.has(content.inReplyTo))
      content.inReplyTo = ids.get(content.inReplyTo);
    copies.push({
      tableName: "messages",
      memory: {
        ...row,
        id: ids.get(row.id!),
        roomId: targetRoomId,
        content,
        metadata: {
          ...row.metadata,
          forkSourceMessageId: row.id,
          forkSourceRoomId: roomId,
          forkAttachmentMessageId:
            (row.metadata as Record<string, unknown> | undefined)
              ?.forkAttachmentMessageId ?? row.id,
          forkAttachmentConversationId:
            (row.metadata as Record<string, unknown> | undefined)
              ?.forkAttachmentConversationId ?? sourceConversationId,
        } as Memory["metadata"],
      },
    });
    const segmentIds = collectMessageContentSegmentIds(row.id!, row.content);
    if (!segmentIds.length) continue;
    const segments = await runtime.getMemoriesByIds(
      segmentIds,
      MESSAGE_CONTENT_SEGMENT_TABLE,
    );
    if (segments.length !== segmentIds.length)
      throw Error("Conversation content is incomplete");
    const byId = new Map(segments.map((segment) => [segment.id, segment]));
    for (const segmentId of segmentIds) {
      const segment = byId.get(segmentId);
      if (!segment) throw Error("Conversation content is incomplete");
      const meta = segment.metadata as unknown as MessageContentSegmentMetadata;
      if (segment.roomId !== roomId || meta.messageId !== row.id)
        throw Error("Conversation content scope changed");
      const newMessageId = ids.get(row.id!)!;
      copies.push({
        tableName: MESSAGE_CONTENT_SEGMENT_TABLE,
        memory: {
          ...segment,
          roomId: targetRoomId,
          id: messageContentSegmentId({
            messageId: newMessageId,
            kind: meta.sourceKind,
            revision: meta.sourceRevision,
            ordinal: meta.ordinal,
            attachmentHash: meta.attachmentIdHash,
          }),
          metadata: {
            ...meta,
            messageId: newMessageId,
          } as unknown as Memory["metadata"],
        },
      });
    }
  }
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify(
        copies.map(
          ({ memory: { embedding, similarity, ...memory }, tableName }) => ({
            memory,
            tableName,
          }),
        ),
      ),
    )
    .digest("hex");
  return { copies, fingerprint, messageIds: Object.fromEntries(ids) };
}
