/** Exercises chat persistence and dedupe against real SQLite before and after storage closes. */
import { ChannelType, stringToUuid } from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import {
  getRecentVisibleAssistantMemorySince,
  persistAssistantConversationMemory,
} from "../src/api/chat-routes.ts";

it("preserves healthy dedupe and rejects unavailable storage without inventing an empty result", async () => {
  const runtime = createSQLiteTestRuntime({
    character: { name: "Chat dedupe storage", bio: ["Test"] },
    logLevel: "fatal",
  });
  let roomId = stringToUuid("chat-dedupe-storage-room");
  const since = Date.now();
  let closed = false;
  try {
    expect(
      await getRecentVisibleAssistantMemorySince(runtime, roomId, since),
    ).toBeNull();
    const first = await persistAssistantConversationMemory(
      runtime,
      roomId,
      "hello",
      ChannelType.API,
      since,
    );
    expect(first?.id).toBeTruthy();
    expect(
      await persistAssistantConversationMemory(
        runtime,
        roomId,
        "hello",
        ChannelType.API,
        since,
      ),
    ).toBeNull();
    expect(
      await getRecentVisibleAssistantMemorySince(runtime, roomId, since),
    ).toEqual({ id: first?.id, text: "hello" });
    expect(
      await runtime.getMemories({ roomId, tableName: "messages", count: 10 }),
    ).toHaveLength(1);
    await runtime.adapter.close();
    closed = true;
    // A fresh room avoids the runtime's short-lived read coalescing cache.
    roomId = stringToUuid("chat-dedupe-storage-unavailable-room");
    await expect(
      persistAssistantConversationMemory(
        runtime,
        roomId,
        "hello",
        ChannelType.API,
        since,
      ),
    ).rejects.toMatchObject({
      code: "ASSISTANT_DEDUPE_READ_FAILED",
      cause: expect.any(Error),
      context: { roomId },
    });
    await expect(
      getRecentVisibleAssistantMemorySince(runtime, roomId, since),
    ).rejects.toMatchObject({
      code: "ASSISTANT_MEMORY_READ_FAILED",
      cause: expect.any(Error),
      context: { roomId },
    });
  } finally {
    if (!closed) await runtime.adapter.close();
  }
});
