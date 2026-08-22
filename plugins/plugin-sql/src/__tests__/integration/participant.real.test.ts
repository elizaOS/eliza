/**
 * Integration tests for room participant add/remove/state against a real
 * isolated PGlite/Postgres adapter.
 */
import { type AgentRuntime, ChannelType, type Entity, type Room, type UUID } from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PgDatabaseAdapter } from "../../pg/adapter";
import type { PgliteDatabaseAdapter } from "../../pglite/adapter";
import { agentTable, participantTable } from "../../schema";
import type { DrizzleDatabase } from "../../types";
import { createIsolatedTestDatabase } from "../test-helpers";

describe("Participant Integration Tests", () => {
  let adapter: PgliteDatabaseAdapter | PgDatabaseAdapter;
  let _runtime: AgentRuntime;
  let cleanup: () => Promise<void>;
  let testAgentId: UUID;
  let testRoomId: UUID;
  let testEntityId: UUID;

  beforeAll(async () => {
    const setup = await createIsolatedTestDatabase("participant-tests");
    adapter = setup.adapter;
    _runtime = setup.runtime;
    cleanup = setup.cleanup;
    testAgentId = setup.testAgentId;

    testRoomId = uuidv4() as UUID;
    testEntityId = uuidv4() as UUID;

    await adapter.createRooms([
      {
        id: testRoomId,
        agentId: testAgentId,
        name: "Test Room",
        source: "test",
        type: ChannelType.GROUP,
        metadata: { connectorAccountId: "account-a" },
      } as Room,
    ]);
    await adapter.createEntities([
      {
        id: testEntityId,
        agentId: testAgentId,
        names: ["Test Entity"],
      } as Entity,
    ]);
  });

  afterAll(async () => {
    if (cleanup) {
      await cleanup();
    }
  });

  describe("Participant Tests", () => {
    beforeEach(async () => {
      await (adapter.getDatabase() as DrizzleDatabase).delete(participantTable);
    });

    it("should add and retrieve a participant", async () => {
      const result = await adapter.addParticipant(testEntityId, testRoomId);
      expect(result).toBe(true);
      const rooms = await adapter.getRoomsForParticipant(testEntityId);
      expect(rooms).toContain(testRoomId);
    });

    it("should remove a participant from a room", async () => {
      await adapter.addParticipant(testEntityId, testRoomId);
      let rooms = await adapter.getRoomsForParticipant(testEntityId);
      expect(rooms).toContain(testRoomId);

      const result = await adapter.removeParticipant(testEntityId, testRoomId);
      expect(result).toBe(true);
      rooms = await adapter.getRoomsForParticipant(testEntityId);
      expect(rooms).not.toContain(testRoomId);
    });

    it("should manage participant state", async () => {
      await adapter.addParticipant(testEntityId, testRoomId);
      await adapter.setParticipantUserState(testRoomId, testEntityId, "FOLLOWED");
      let state = await adapter.getParticipantUserState(testRoomId, testEntityId);
      expect(state).toBe("FOLLOWED");

      await adapter.setParticipantUserState(testRoomId, testEntityId, null);
      state = await adapter.getParticipantUserState(testRoomId, testEntityId);
      expect(state).toBeNull();
    });

    it("should check if entity is room participant", async () => {
      let isParticipant = await adapter.isRoomParticipant(testRoomId, testEntityId);
      expect(isParticipant).toBe(false);

      await adapter.addParticipant(testEntityId, testRoomId);
      isParticipant = await adapter.isRoomParticipant(testRoomId, testEntityId);
      expect(isParticipant).toBe(true);

      await adapter.removeParticipant(testEntityId, testRoomId);
      isParticipant = await adapter.isRoomParticipant(testRoomId, testEntityId);
      expect(isParticipant).toBe(false);
    });

    it("should return false for non-existent room participant check", async () => {
      const nonExistentRoomId = uuidv4() as UUID;
      const nonExistentEntityId = uuidv4() as UUID;
      const isParticipant = await adapter.isRoomParticipant(nonExistentRoomId, nonExistentEntityId);
      expect(isParticipant).toBe(false);
    });

    it("rejects participant creation outside the adapter tenant", async () => {
      await expect(adapter.addParticipant(uuidv4() as UUID, testRoomId)).rejects.toMatchObject({
        code: "PARTICIPANT_TENANT_FORBIDDEN",
      });
      await expect(adapter.addParticipant(testEntityId, uuidv4() as UUID)).rejects.toMatchObject({
        code: "PARTICIPANT_TENANT_FORBIDDEN",
      });
      await expect(
        adapter.addParticipantsRoom([testEntityId, uuidv4() as UUID], testRoomId)
      ).rejects.toMatchObject({ code: "PARTICIPANT_TENANT_FORBIDDEN" });
      expect(await adapter.getRoomsForParticipant(testEntityId)).toEqual([]);
    });

    it("removes only this agent's participant row", async () => {
      const foreignAgentId = uuidv4() as UUID;
      const database = adapter.getDatabase() as DrizzleDatabase;
      await database.insert(agentTable).values({ id: foreignAgentId, name: "Foreign Agent" });
      await adapter.addParticipant(testEntityId, testRoomId);
      await database.insert(participantTable).values({
        agentId: foreignAgentId,
        entityId: testEntityId,
        roomId: testRoomId,
      });

      await expect(adapter.removeParticipant(testEntityId, testRoomId)).resolves.toBe(true);

      const remaining = await database.select().from(participantTable);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.agentId).toBe(foreignAgentId);
    });

    it("cannot update or delete another agent's room", async () => {
      const foreignAgentId = uuidv4() as UUID;
      const database = adapter.getDatabase() as DrizzleDatabase;
      await database.insert(agentTable).values({ id: foreignAgentId, name: "Foreign Agent" });
      const mutableAdapter = adapter as unknown as { agentId: UUID };
      mutableAdapter.agentId = foreignAgentId;
      try {
        await adapter.updateRoom({
          id: testRoomId,
          agentId: foreignAgentId,
          source: "test",
          type: ChannelType.GROUP,
          name: "Foreign overwrite",
        } as Room);
        await adapter.deleteRoom(testRoomId);
      } finally {
        mutableAdapter.agentId = testAgentId;
      }

      await expect(adapter.getRoomsByIds([testRoomId])).resolves.toMatchObject([
        { id: testRoomId, name: "Test Room", agentId: testAgentId },
      ]);
    });

    it("requires fresh generation-fenced evidence for room entitlement", async () => {
      await adapter.addParticipant(testEntityId, testRoomId);
      expect(await adapter.getCurrentRoomMemberships(testEntityId)).toEqual([]);

      const observedAt = Date.now();
      const first = {
        entityId: testEntityId,
        roomId: testRoomId,
        source: "transport:discord.00000000-0000-4000-8000-000000000999",
        state: "member" as const,
        observedAt,
        expiresAt: observedAt + 60_000,
        cursor: "discord-member-v1",
        generation: 1,
      };
      await expect(
        adapter.updateRoomMembershipEvidence({
          evidence: first,
          expectedGeneration: null,
        })
      ).resolves.toMatchObject({ status: "updated" });
      expect(await adapter.getCurrentRoomMemberships(testEntityId)).toEqual([first]);

      const unavailable = {
        ...first,
        state: "unavailable" as const,
        cursor: "discord-unavailable-v2",
        generation: 2,
      };
      await expect(
        adapter.updateRoomMembershipEvidence({
          evidence: unavailable,
          expectedGeneration: 1,
        })
      ).resolves.toMatchObject({ status: "updated" });
      expect(await adapter.getCurrentRoomMemberships(testEntityId)).toEqual([]);

      await expect(
        adapter.updateRoomMembershipEvidence({
          evidence: { ...first, generation: 2 },
          expectedGeneration: 1,
        })
      ).resolves.toMatchObject({
        status: "conflict",
        current: { state: "unavailable", generation: 2 },
      });
    });

    it("checks persisted connector account inside the membership transaction", async () => {
      await adapter.addParticipant(testEntityId, testRoomId);
      await adapter.upsertRooms([
        {
          id: testRoomId,
          agentId: testAgentId,
          name: "Test Room",
          source: "test",
          type: ChannelType.GROUP,
          metadata: { connectorAccountId: "account-b" },
        } as Room,
      ]);
      const observedAt = Date.now();
      try {
        await expect(
          adapter.updateRoomMembershipEvidence({
            evidence: {
              entityId: testEntityId,
              roomId: testRoomId,
              source: "transport:test.00000000-0000-4000-8000-000000000999",
              state: "member",
              observedAt,
              expiresAt: observedAt + 60_000,
              generation: 1,
            },
            expectedGeneration: null,
            authority: {
              agentId: testAgentId,
              connectorSources: ["test"],
              connectorAccountId: "account-a",
            },
          })
        ).rejects.toMatchObject({
          code: "ROOM_MEMBERSHIP_PUBLISHER_ACCOUNT_FORBIDDEN",
        });
      } finally {
        await adapter.upsertRooms([
          {
            id: testRoomId,
            agentId: testAgentId,
            name: "Test Room",
            source: "test",
            type: ChannelType.GROUP,
            metadata: { connectorAccountId: "account-a" },
          } as Room,
        ]);
      }
    });
  });
});
