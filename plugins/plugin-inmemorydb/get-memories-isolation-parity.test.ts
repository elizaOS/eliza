/**
 * Pins getMemories query parity with plugin-sql for entityId isolation:
 * entityId establishes the caller's RLS principal and must not remove other
 * participants' turns from the same bounded room/agent transcript.
 */
import { randomUUID } from "node:crypto";
import type { AccessContext, Memory, UUID } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";

describe("getMemories entity isolation parity", () => {
  const agentId = randomUUID() as UUID;
  const adminId = randomUUID() as UUID;
  const otherId = randomUUID() as UUID;
  const roomId = randomUUID() as UUID;
  const otherRoomId = randomUUID() as UUID;
  let adapter: InMemoryDatabaseAdapter;

  beforeEach(async () => {
    const storage = new MemoryStorage();
    await storage.init();
    adapter = new InMemoryDatabaseAdapter(storage, agentId);
    await adapter.init();
  });

  it("returns the newest bounded room transcript across participants", async () => {
    const participants = [adminId, agentId, otherId] as const;
    const memories: Memory[] = Array.from({ length: 20 }, (_, index) => ({
      id: randomUUID() as UUID,
      agentId,
      entityId: participants[index % participants.length],
      roomId,
      createdAt: index + 1,
      content: { text: `turn ${index + 1}` },
    }));
    await adapter.createMemories(memories.map((memory) => ({ memory, tableName: "memories" })));
    await adapter.createRoomParticipants([adminId], roomId);

    const result = await adapter.getMemories({
      agentId,
      entityId: adminId,
      roomId,
      limit: 15,
      orderBy: "createdAt",
      orderDirection: "desc",
      unique: false,
      tableName: "memories",
    });

    expect(result.map((memory) => memory.content.text)).toEqual(
      Array.from({ length: 15 }, (_, index) => `turn ${20 - index}`)
    );
    expect(new Set(result.map((memory) => memory.entityId))).toEqual(
      new Set([adminId, agentId, otherId])
    );
  });

  it("denies an unrelated room even when the principal authored its row", async () => {
    await adapter.createRoomParticipants([adminId], roomId);
    await adapter.createMemories([
      {
        memory: {
          id: randomUUID() as UUID,
          agentId,
          entityId: otherId,
          roomId,
          content: { text: "shared room reply" },
        },
        tableName: "memories",
      },
      {
        memory: {
          id: randomUUID() as UUID,
          agentId,
          entityId: adminId,
          roomId: otherRoomId,
          content: { text: "unrelated authored row" },
        },
        tableName: "memories",
      },
    ]);

    const result = await adapter.getMemories({
      entityId: adminId,
      agentId,
      tableName: "memories",
    });

    expect(result.map((memory) => memory.content.text)).toEqual(["shared room reply"]);
  });

  it("preserves agent-owned documents and access-context filtering", async () => {
    await adapter.createRoomParticipants([adminId], roomId);
    await adapter.createRoomParticipants([adminId], otherRoomId);
    await adapter.createMemories([
      {
        memory: {
          id: randomUUID() as UUID,
          agentId: adminId,
          entityId: otherId,
          roomId: randomUUID() as UUID,
          content: { text: "agent-owned document" },
        },
        tableName: "documents",
      },
      {
        memory: {
          id: randomUUID() as UUID,
          agentId,
          entityId: otherId,
          roomId,
          content: { text: "authorized room" },
        },
        tableName: "messages",
      },
      {
        memory: {
          id: randomUUID() as UUID,
          agentId,
          entityId: otherId,
          roomId: otherRoomId,
          content: { text: "participant but unauthorized room" },
        },
        tableName: "messages",
      },
    ]);

    await expect(
      adapter.getMemories({
        entityId: adminId,
        agentId: adminId,
        tableName: "documents",
      })
    ).resolves.toMatchObject([{ content: { text: "agent-owned document" } }]);

    const accessContext: AccessContext = {
      requesterEntityId: adminId,
      authorizedRoomIds: [roomId],
      role: "USER",
      isOwner: false,
    };
    const messages = await adapter.getMemories({
      entityId: adminId,
      agentId,
      tableName: "messages",
      accessContext,
    });
    expect(messages.map((memory) => memory.content.text)).toEqual(["authorized room"]);
  });
});
