/**
 * Exercises the real ephemeral adapter's membership CAS under concurrent
 * connector observations so it cannot report two winners for one generation.
 */

import { randomUUID } from "node:crypto";
import {
  ChannelType,
  type Entity,
  type Room,
  type RoomMembershipEvidence,
  type UUID,
} from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "./adapter";
import { MemoryStorage } from "./storage-memory";
import { COLLECTIONS } from "./types";

async function seedCurrentMembership(
  adapter: InMemoryDatabaseAdapter,
  agentId: UUID,
  entityId: UUID,
  roomId: UUID,
  worldId?: UUID
): Promise<void> {
  await adapter.createEntities([{ id: entityId, agentId, names: ["Member"] } as Entity]);
  await adapter.createRooms([
    {
      id: roomId,
      agentId,
      source: "matrix",
      type: ChannelType.GROUP,
      worldId,
    } as Room,
  ]);
  await adapter.createRoomParticipants([entityId], roomId);
  const observedAt = Date.now();
  await adapter.updateRoomMembershipEvidence({
    evidence: {
      entityId,
      roomId,
      source: "transport:matrix.00000000-0000-4000-8000-000000000999",
      state: "member",
      observedAt,
      expiresAt: observedAt + 60_000,
      generation: 1,
    },
    expectedGeneration: null,
  });
}

describe("room membership evidence", () => {
  it("isolates matching room and entity ids between agents sharing storage", async () => {
    const storage = new MemoryStorage();
    await storage.init();
    const agentA = new InMemoryDatabaseAdapter(storage, randomUUID() as UUID);
    const agentB = new InMemoryDatabaseAdapter(storage, randomUUID() as UUID);
    const entityId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    await Promise.all([agentA.init(), agentB.init()]);
    await Promise.all([
      agentA.createRoomParticipants([entityId], roomId),
      agentB.createRoomParticipants([entityId], roomId),
    ]);
    const observedAt = Date.now();
    const evidence = {
      entityId,
      roomId,
      source: "transport:matrix.00000000-0000-4000-8000-000000000999",
      state: "member" as const,
      observedAt,
      expiresAt: observedAt + 60_000,
      generation: 1,
    };
    await expect(
      agentA.updateRoomMembershipEvidence({
        evidence: { ...evidence, cursor: "agent-a" },
        expectedGeneration: null,
      })
    ).resolves.toMatchObject({ status: "updated" });
    await expect(agentB.getCurrentRoomMemberships(entityId)).resolves.toEqual([]);
    await expect(
      agentB.updateRoomMembershipEvidence({
        evidence: { ...evidence, cursor: "agent-b" },
        expectedGeneration: null,
      })
    ).resolves.toMatchObject({ status: "updated" });
    await expect(agentA.getCurrentRoomMemberships(entityId)).resolves.toMatchObject([
      { cursor: "agent-a" },
    ]);
    await expect(agentB.getCurrentRoomMemberships(entityId)).resolves.toMatchObject([
      { cursor: "agent-b" },
    ]);
  });

  it("serializes competing replacements and preserves exactly one winner", async () => {
    const agentId = randomUUID() as UUID;
    const entityId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    const storage = new MemoryStorage();
    await storage.init();
    const adapterA = new InMemoryDatabaseAdapter(storage, agentId);
    const adapterB = new InMemoryDatabaseAdapter(storage, agentId);
    await Promise.all([adapterA.init(), adapterB.init()]);
    await adapterA.createRoomParticipants([entityId], roomId);
    const observedAt = Date.now();
    const first: RoomMembershipEvidence = {
      entityId,
      roomId,
      source: "transport:matrix.00000000-0000-4000-8000-000000000999",
      state: "member",
      observedAt,
      expiresAt: observedAt + 60_000,
      generation: 1,
    };
    await expect(
      adapterA.updateRoomMembershipEvidence({
        evidence: first,
        expectedGeneration: null,
      })
    ).resolves.toMatchObject({ status: "updated" });

    const results = await Promise.all(
      [adapterA, adapterB].map((adapter, index) =>
        adapter.updateRoomMembershipEvidence({
          evidence: { ...first, cursor: `cursor-${index}`, generation: 2 },
          expectedGeneration: 1,
        })
      )
    );
    expect(results.map((result) => result.status).sort()).toEqual(["conflict", "updated"]);
    const current = await adapterB.getCurrentRoomMemberships(entityId);
    expect(current).toHaveLength(1);
    expect(["cursor-0", "cursor-1"]).toContain(current[0]?.cursor);
    expect(current[0]?.generation).toBe(2);
  });

  it("orders room account reassignment before a queued membership publication", async () => {
    const agentId = randomUUID() as UUID;
    const entityId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    const storage = new MemoryStorage();
    await storage.init();
    const adapterA = new InMemoryDatabaseAdapter(storage, agentId);
    const adapterB = new InMemoryDatabaseAdapter(storage, agentId);
    await Promise.all([adapterA.init(), adapterB.init()]);
    await adapterA.createEntities([{ id: entityId, agentId, names: ["Member"] } as Entity]);
    await adapterA.createRooms([
      {
        id: roomId,
        agentId,
        source: "matrix",
        type: ChannelType.GROUP,
        metadata: { connectorAccountId: "account-a" },
      } as Room,
    ]);
    await adapterA.createRoomParticipants([entityId], roomId);

    const reassignment = adapterB.upsertRooms([
      {
        id: roomId,
        agentId,
        source: "matrix",
        type: ChannelType.GROUP,
        metadata: { connectorAccountId: "account-b" },
      } as Room,
    ]);
    const observedAt = Date.now();
    const publication = adapterA.updateRoomMembershipEvidence({
      evidence: {
        entityId,
        roomId,
        source: "transport:matrix.00000000-0000-4000-8000-000000000999",
        state: "member",
        observedAt,
        expiresAt: observedAt + 60_000,
        generation: 1,
      },
      expectedGeneration: null,
      authority: {
        agentId,
        connectorSources: ["matrix"],
        connectorAccountId: "account-a",
      },
    });
    const publicationRejection = expect(publication).rejects.toMatchObject({
      code: "ROOM_MEMBERSHIP_PUBLISHER_ACCOUNT_FORBIDDEN",
    });

    await expect(reassignment).resolves.toBeUndefined();
    await publicationRejection;
  });

  it("does not let a concurrent participant metadata update restore stale evidence", async () => {
    const agentId = randomUUID() as UUID;
    const entityId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    const storage = new MemoryStorage();
    await storage.init();
    const adapterA = new InMemoryDatabaseAdapter(storage, agentId);
    const adapterB = new InMemoryDatabaseAdapter(storage, agentId);
    await Promise.all([adapterA.init(), adapterB.init()]);
    await adapterA.createRoomParticipants([entityId], roomId);
    const observedAt = Date.now();
    const first: RoomMembershipEvidence = {
      entityId,
      roomId,
      source: "transport:matrix.00000000-0000-4000-8000-000000000999",
      state: "member",
      observedAt,
      expiresAt: observedAt + 60_000,
      generation: 1,
    };
    await adapterA.updateRoomMembershipEvidence({ evidence: first, expectedGeneration: null });

    await Promise.all([
      adapterA.updateParticipants([
        { entityId, roomId, updates: { metadata: { displayName: "Current member" } } },
      ]),
      adapterB.updateRoomMembershipEvidence({
        evidence: { ...first, generation: 2, cursor: "replacement" },
        expectedGeneration: 1,
      }),
    ]);

    await expect(adapterA.getCurrentRoomMemberships(entityId)).resolves.toMatchObject([
      { generation: 2, cursor: "replacement" },
    ]);
  });

  it("cascades entity deletion through persisted membership evidence", async () => {
    const agentId = randomUUID() as UUID;
    const entityId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    const storage = new MemoryStorage();
    await storage.init();
    const adapter = new InMemoryDatabaseAdapter(storage, agentId);
    await adapter.init();
    await seedCurrentMembership(adapter, agentId, entityId, roomId);

    await adapter.deleteEntities([entityId]);

    await expect(adapter.getCurrentRoomMemberships(entityId)).resolves.toEqual([]);
    await expect(adapter.areRoomParticipants([{ roomId, entityId }])).resolves.toEqual([false]);
  });

  it("atomically cascades world room deletion through membership evidence", async () => {
    const agentId = randomUUID() as UUID;
    const entityId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    const worldId = randomUUID() as UUID;
    const storage = new MemoryStorage();
    await storage.init();
    const adapter = new InMemoryDatabaseAdapter(storage, agentId);
    await adapter.init();
    await seedCurrentMembership(adapter, agentId, entityId, roomId, worldId);

    await adapter.deleteRoomsByWorldIds([worldId]);

    await expect(adapter.getCurrentRoomMemberships(entityId)).resolves.toEqual([]);
    await expect(adapter.areRoomParticipants([{ roomId, entityId }])).resolves.toEqual([false]);
  });

  it("orders a room world move before a queued world deletion", async () => {
    const agentId = randomUUID() as UUID;
    const entityId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    const originalWorldId = randomUUID() as UUID;
    const targetWorldId = randomUUID() as UUID;
    let releaseRoomRead: (() => void) | undefined;
    const roomReadGate = new Promise<void>((resolve) => {
      releaseRoomRead = resolve;
    });
    class GatedRoomReadStorage extends MemoryStorage {
      override async getWhere<T>(
        collection: string,
        predicate: (item: T) => boolean
      ): Promise<T[]> {
        if (collection === COLLECTIONS.ROOMS) await roomReadGate;
        return super.getWhere(collection, predicate);
      }
    }
    const storage = new GatedRoomReadStorage();
    await storage.init();
    const adapterA = new InMemoryDatabaseAdapter(storage, agentId);
    const adapterB = new InMemoryDatabaseAdapter(storage, agentId);
    await Promise.all([adapterA.init(), adapterB.init()]);
    await seedCurrentMembership(adapterA, agentId, entityId, roomId, targetWorldId);

    const deletion = adapterB.deleteRoomsByWorldIds([targetWorldId]);
    let moveSettled = false;
    const move = adapterA
      .updateRooms([
        {
          id: roomId,
          agentId,
          source: "matrix",
          type: ChannelType.GROUP,
          worldId: originalWorldId,
        } as Room,
      ])
      .then(() => {
        moveSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const moveOvertookDeletionSelection = moveSettled;
    releaseRoomRead?.();
    await Promise.all([move, deletion]);

    expect(moveOvertookDeletionSelection).toBe(false);
    await expect(adapterA.getRoomsByIds([roomId])).resolves.toEqual([]);
    await expect(adapterA.getCurrentRoomMemberships(entityId)).resolves.toEqual([]);
  });

  it("rejects cross-agent room and entity ownership reassignment", async () => {
    const agentAId = randomUUID() as UUID;
    const agentBId = randomUUID() as UUID;
    const entityId = randomUUID() as UUID;
    const roomId = randomUUID() as UUID;
    const storage = new MemoryStorage();
    await storage.init();
    const adapterA = new InMemoryDatabaseAdapter(storage, agentAId);
    const adapterB = new InMemoryDatabaseAdapter(storage, agentBId);
    await Promise.all([adapterA.init(), adapterB.init()]);
    await adapterA.createEntities([
      { id: entityId, agentId: agentAId, names: ["Agent A member"] } as Entity,
    ]);
    await adapterA.createRooms([
      {
        id: roomId,
        agentId: agentAId,
        source: "matrix",
        type: ChannelType.GROUP,
      } as Room,
    ]);

    await expect(
      adapterB.upsertEntities([{ id: entityId, agentId: agentBId, names: ["Stolen"] } as Entity])
    ).rejects.toMatchObject({ code: "INMEMORY_TENANT_FORBIDDEN" });
    await expect(
      adapterB.upsertRooms([
        {
          id: roomId,
          agentId: agentBId,
          source: "matrix",
          type: ChannelType.GROUP,
        } as Room,
      ])
    ).rejects.toMatchObject({ code: "INMEMORY_TENANT_FORBIDDEN" });
    await expect(adapterA.getEntitiesByIds([entityId])).resolves.toMatchObject([
      { agentId: agentAId, names: ["Agent A member"] },
    ]);
    await expect(adapterA.getRoomsByIds([roomId])).resolves.toMatchObject([{ agentId: agentAId }]);
  });
});
