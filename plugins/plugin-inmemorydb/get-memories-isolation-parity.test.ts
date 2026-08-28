/**
 * Pins getMemories query parity with plugin-sql for entityId isolation:
 * entityId establishes the caller's RLS principal and must not remove other
 * participants' turns from the same bounded room/agent transcript.
 */
import { randomUUID } from "node:crypto";
import {
  type AccessContext,
  type IAgentRuntime,
  type Memory,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import { adminChatProvider } from "../../packages/core/src/features/autonomy/providers";
import {
  AUTONOMY_SERVICE_TYPE,
  type AutonomyService,
} from "../../packages/core/src/features/autonomy/service";
import { createMockRuntime } from "../../packages/core/src/testing/mock-runtime";
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

describe("admin history provider adapter parity", () => {
  it("reads only actual admin-participant rooms and keeps the newest fifteen turns", async () => {
    const agentId = randomUUID() as UUID;
    const autonomyEntityId = randomUUID() as UUID;
    const otherEntityId = randomUUID() as UUID;
    const adminUserId = "provider-parity-admin";
    const adminId = stringToUuid(adminUserId);
    const autonomousRoomId = randomUUID() as UUID;
    const adminRoomId = randomUUID() as UUID;
    const unrelatedRoomId = randomUUID() as UUID;
    const storage = new MemoryStorage();
    await storage.init();
    const adapter = new InMemoryDatabaseAdapter(storage, agentId);
    await adapter.init();

    await adapter.createRoomParticipants([agentId, autonomyEntityId], autonomousRoomId);
    await adapter.createRoomParticipants([adminId, agentId], adminRoomId);
    await adapter.createRoomParticipants([otherEntityId, agentId], unrelatedRoomId);

    const adminRoomHistory = Array.from(
      { length: 20 },
      (_, index): Memory => ({
        id: randomUUID() as UUID,
        agentId,
        entityId: index % 2 === 0 ? adminId : agentId,
        roomId: adminRoomId,
        createdAt: index + 1,
        content: { text: `admin room turn ${index + 1}` },
      })
    );
    await adapter.createMemories([
      ...adminRoomHistory.map((memory) => ({ memory, tableName: "memories" })),
      {
        memory: {
          id: randomUUID() as UUID,
          agentId,
          entityId: autonomyEntityId,
          roomId: autonomousRoomId,
          createdAt: 1_000,
          content: { text: "internal autonomous turn must stay private" },
        },
        tableName: "memories",
      },
      {
        memory: {
          id: randomUUID() as UUID,
          agentId,
          entityId: otherEntityId,
          roomId: unrelatedRoomId,
          createdAt: 2_000,
          content: { text: "unrelated room turn must stay private" },
        },
        tableName: "memories",
      },
    ]);

    const autonomyService = {
      getAutonomousRoomId: () => autonomousRoomId,
    } as Pick<AutonomyService, "getAutonomousRoomId">;
    const runtime = createMockRuntime({
      agentId,
      getSetting: (key: string) => (key === "ADMIN_USER_ID" ? adminUserId : undefined),
      getService: ((serviceType: string) =>
        serviceType === AUTONOMY_SERVICE_TYPE
          ? autonomyService
          : null) as IAgentRuntime["getService"],
      getRoomsForParticipant: (entityId: UUID) => adapter.getRoomsForParticipants([entityId]),
      getMemories: (params) => adapter.getMemories(params),
    });

    const result = await adminChatProvider.get(runtime, {
      agentId,
      entityId: autonomyEntityId,
      roomId: autonomousRoomId,
      content: { text: "autonomous tick" },
    });

    expect(result.data).toMatchObject({
      messageCount: 15,
      historyWindowCount: 15,
    });
    for (let index = 1; index <= 5; index += 1) {
      expect(result.text).not.toContain(`admin room turn ${index}\n`);
    }
    for (let index = 6; index <= 20; index += 1) {
      expect(result.text).toContain(`admin room turn ${index}`);
    }
    expect(result.text).toContain("Agent: admin room turn 20");
    expect(result.text).not.toContain("internal autonomous turn must stay private");
    expect(result.text).not.toContain("unrelated room turn must stay private");
    expect(result.text?.indexOf("admin room turn 6")).toBeLessThan(
      result.text?.indexOf("admin room turn 20") ?? -1
    );
  });
});
