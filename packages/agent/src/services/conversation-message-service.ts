/**
 * Owns conversation-message deletion and truncation against the runtime
 * persistence contract. HTTP routes supply an authorized conversation and
 * translate the service's status-bearing not-found error at their boundary.
 */
import type { AgentRuntime, UUID } from "@elizaos/core";
import type { ConversationMeta } from "../api/server-types.ts";

type DeletableRuntime = AgentRuntime & {
  deleteManyMemories?: (memoryIds: UUID[]) => Promise<unknown>;
  deleteMemory?: (memoryId: UUID) => Promise<unknown>;
  removeMemory?: (memoryId: UUID) => Promise<unknown>;
  adapter: AgentRuntime["adapter"] & {
    db: {
      deleteManyMemories?: (memoryIds: UUID[]) => Promise<unknown>;
      deleteMemory?: (memoryId: UUID) => Promise<unknown>;
      removeMemory?: (memoryId: UUID) => Promise<unknown>;
    };
  };
};

function conversationMessageNotFound(): Error & { status: number } {
  return Object.assign(new Error("Conversation message not found"), {
    status: 404,
  });
}

export async function deleteConversationMemories(
  runtime: AgentRuntime,
  memoryIds: UUID[],
): Promise<number> {
  if (memoryIds.length === 0) return 0;
  const deletable = runtime as DeletableRuntime;
  if (typeof deletable.deleteManyMemories === "function") {
    await deletable.deleteManyMemories(memoryIds);
    return memoryIds.length;
  }
  if (typeof deletable.adapter.db.deleteManyMemories === "function") {
    await deletable.adapter.db.deleteManyMemories(memoryIds);
    return memoryIds.length;
  }

  for (const memoryId of memoryIds) {
    if (typeof deletable.deleteMemory === "function") {
      await deletable.deleteMemory(memoryId);
    } else if (typeof deletable.removeMemory === "function") {
      await deletable.removeMemory(memoryId);
    } else if (typeof deletable.adapter.db.deleteMemory === "function") {
      await deletable.adapter.db.deleteMemory(memoryId);
    } else if (typeof deletable.adapter.db.removeMemory === "function") {
      await deletable.adapter.db.removeMemory(memoryId);
    } else {
      throw Object.assign(
        new Error("Conversation message deletion is not supported"),
        { status: 501 },
      );
    }
  }
  return memoryIds.length;
}

export async function deleteConversationMessage(
  runtime: AgentRuntime,
  conversation: ConversationMeta,
  messageId: string,
): Promise<{ deletedCount: number }> {
  const [memory] = await runtime.getMemoriesByIds(
    [messageId as UUID],
    "messages",
  );
  // A cross-room id is indistinguishable from absence so callers cannot use
  // this endpoint to confirm foreign message existence.
  if (!memory || memory.roomId !== conversation.roomId) {
    throw conversationMessageNotFound();
  }
  return {
    deletedCount: await deleteConversationMemories(runtime, [
      messageId as UUID,
    ]),
  };
}

export async function truncateConversationMessages(
  runtime: AgentRuntime,
  conversation: ConversationMeta,
  messageId: string,
  options?: { inclusive?: boolean },
): Promise<{ deletedCount: number }> {
  const memories = await runtime.getMemories({
    roomId: conversation.roomId,
    tableName: "messages",
    limit: 1_000,
  });
  memories.sort(
    (left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0),
  );
  const targetIndex = memories.findIndex((memory) => memory.id === messageId);
  if (targetIndex < 0) throw conversationMessageNotFound();
  const start = options?.inclusive === true ? targetIndex : targetIndex + 1;
  const memoryIds = memories
    .slice(start)
    .map((memory) => memory.id)
    .filter(
      (memoryId): memoryId is UUID =>
        typeof memoryId === "string" && memoryId.trim().length > 0,
    );
  return {
    deletedCount: await deleteConversationMemories(runtime, memoryIds),
  };
}
