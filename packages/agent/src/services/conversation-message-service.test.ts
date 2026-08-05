/** Verifies conversation deletion ownership and storage delegation without HTTP. */
import type { AgentRuntime, Memory, UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import {
  deleteConversationMemories,
  deleteConversationMessage,
  truncateConversationMessages,
} from "./conversation-message-service.ts";

const roomId = "00000000-0000-4000-8000-000000000001" as UUID;
const conversation = { id: "conversation", roomId } as Parameters<
  typeof deleteConversationMessage
>[1];

function runtime(methods: Record<string, unknown>): AgentRuntime {
  return {
    adapter: { db: {} },
    ...methods,
  } as unknown as AgentRuntime;
}

describe("conversation message service", () => {
  it("uses the runtime bulk deletion contract", async () => {
    const deleteManyMemories = vi.fn(async () => undefined);
    const ids = ["00000000-0000-4000-8000-000000000002" as UUID];
    await expect(
      deleteConversationMemories(runtime({ deleteManyMemories }), ids),
    ).resolves.toBe(1);
    expect(deleteManyMemories).toHaveBeenCalledWith(ids);
  });

  it("does not reveal whether a message belongs to another room", async () => {
    const foreign = {
      id: "00000000-0000-4000-8000-000000000003" as UUID,
      roomId: "00000000-0000-4000-8000-000000000004" as UUID,
    } as Memory;
    const target = runtime({ getMemoriesByIds: async () => [foreign] });
    await expect(
      deleteConversationMessage(target, conversation, String(foreign.id)),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("truncates only messages after the selected pivot", async () => {
    const ids = [2, 3, 4].map(
      (suffix) => `00000000-0000-4000-8000-00000000000${suffix}` as UUID,
    );
    const deleteManyMemories = vi.fn(async () => undefined);
    const target = runtime({
      deleteManyMemories,
      getMemories: async () =>
        ids.map((id, index) => ({ id, roomId, createdAt: index + 1 })),
    });
    await expect(
      truncateConversationMessages(target, conversation, ids[1]),
    ).resolves.toEqual({ deletedCount: 1 });
    expect(deleteManyMemories).toHaveBeenCalledWith([ids[2]]);
  });
});
