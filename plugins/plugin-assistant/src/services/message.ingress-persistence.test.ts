/** Exercises exact host-prepersisted ingress through the real message service and SQLite runtime, including complete native segments and conflicting identities. */
import {
  ContentType,
  collectMessageContentSegmentIds,
  type Memory,
  persistIncomingMessageMemory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { createSQLiteTestRuntime } from "@elizaos/testing";
import { describe, expect, it } from "vitest";
import { DefaultMessageService } from "./message.ts";

function harness() {
  const runtime = createSQLiteTestRuntime({
    character: {
      name: "Ingress receipt",
      bio: "test",
      settings: { BASIC_CAPABILITIES_DEFLLMOFF: true },
    },
    logLevel: "fatal",
  });
  const memory: Memory & { id: UUID } = {
    id: stringToUuid("host-ingress"),
    agentId: runtime.agentId,
    entityId: stringToUuid("host-owner"),
    roomId: stringToUuid("host-room"),
    content: { text: "Hello from the host", source: "client_chat" },
  };
  return { runtime, memory };
}

describe("exact ingress persistence", () => {
  it("processes the host's already persisted message without a second strict create", async () => {
    const { runtime, memory } = harness();
    try {
      await runtime.createMemory(memory, "messages");
      const result = await new DefaultMessageService().handleMessage(
        runtime,
        memory,
      );
      expect(result.didRespond).toBe(false);
      expect((await runtime.getMemoryById(memory.id))?.content).toEqual(
        memory.content,
      );
    } finally {
      await runtime.adapter.close();
    }
  });
  it("reuses complete segmented Unicode and attachments, while ordinary create remains strict", async () => {
    const { runtime, memory } = harness();
    memory.content.text = "🙂 Hebrew עברית complete\n".repeat(10000);
    memory.content.attachments = [
      {
        id: "attachment",
        url: "local:attachment",
        source: "test",
        title: "full",
        description: "full attachment\n".repeat(20000),
        contentType: ContentType.DOCUMENT,
      },
    ];
    try {
      await runtime.createMessageMemory(memory);
      await expect(persistIncomingMessageMemory(runtime, memory)).resolves.toBe(
        memory.id,
      );
      await expect(runtime.createMessageMemory(memory)).rejects.toMatchObject({
        code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT",
      });
      const stored = await runtime.getMemoryById(memory.id);
      expect(stored?.content.messageTextSource).toBeDefined();
      await expect(
        persistIncomingMessageMemory(runtime, {
          ...memory,
          content: {
            ...memory.content,
            text: `${memory.content.text}different`,
          },
        }),
      ).rejects.toMatchObject({ code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT" });
      await expect(
        persistIncomingMessageMemory(runtime, {
          ...memory,
          roomId: stringToUuid("another-room"),
        }),
      ).rejects.toMatchObject({ code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT" });
      if (!stored) throw new Error("Expected published message");
      const [segmentId] = collectMessageContentSegmentIds(
        memory.id,
        stored.content,
      );
      if (!segmentId) throw new Error("Expected native segment");
      await runtime.adapter.deleteMemories([segmentId]);
      await expect(
        persistIncomingMessageMemory(runtime, memory),
      ).rejects.toMatchObject({ code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT" });
    } finally {
      await runtime.adapter.close();
    }
  });
  it("settles concurrent exact ingress publication without accepting a conflicting request", async () => {
    const { runtime, memory } = harness();
    try {
      const ids = await Promise.all([
        persistIncomingMessageMemory(runtime, memory),
        persistIncomingMessageMemory(runtime, memory),
      ]);
      expect(ids).toEqual([memory.id, memory.id]);
      await expect(
        persistIncomingMessageMemory(runtime, {
          ...memory,
          entityId: stringToUuid("different-owner"),
        }),
      ).rejects.toMatchObject({ code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT" });
    } finally {
      await runtime.adapter.close();
    }
  });
  it("does not reuse another table's identical row", async () => {
    const { runtime, memory } = harness();
    try {
      await runtime.createMemory(memory, "notes");
      await expect(
        persistIncomingMessageMemory(runtime, memory),
      ).rejects.toMatchObject({ code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT" });
      expect(await runtime.getMemoriesByIds([memory.id], "messages")).toEqual(
        [],
      );
    } finally {
      await runtime.adapter.close();
    }
  });
  it("matches storage redaction without changing content or accepting unrelated text", async () => {
    const { runtime, memory } = harness();
    runtime.setSetting("TEST_API_KEY", "secret-ingress-value");
    memory.content.text = "Use secret-ingress-value";
    try {
      await runtime.createMemory(memory, "messages");
      await expect(persistIncomingMessageMemory(runtime, memory)).resolves.toBe(
        memory.id,
      );
      await expect(
        persistIncomingMessageMemory(runtime, {
          ...memory,
          content: { text: "different" },
        }),
      ).rejects.toMatchObject({ code: "MESSAGE_CONTENT_PUBLICATION_CONFLICT" });
    } finally {
      await runtime.adapter.close();
    }
  });
});
