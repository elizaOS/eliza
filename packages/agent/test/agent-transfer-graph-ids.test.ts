/**
 * An agent transfer mints new ids for every entity, world and memory. Ids that
 * live inside JSON columns (world ownership and roles, a reply's inReplyTo)
 * must be remapped with them, and relationships between the agent's users
 * must travel too, or the imported agent forgets its owner and its threads.
 */
import {
  ChannelType,
  type Entity,
  type Memory,
  type Room,
  stringToUuid,
  type UUID,
  type World,
} from "@elizaos/core";
import { expect, it } from "vitest";
import { createRealTestRuntime } from "../../app/test/helpers/real-runtime.ts";
import { exportAgent, importAgent } from "../src/services/agent-export.ts";

const PASSWORD = "transfer-graph-password";

it("keeps world roles, reply threads and user relationships through a transfer", async () => {
  const source = await createRealTestRuntime({ characterName: "GraphSource" });
  const target = await createRealTestRuntime({ characterName: "GraphTarget" });
  try {
    const adapter = source.runtime.adapter;
    const agentId = source.runtime.agentId;
    const owner = stringToUuid("transfer-owner");
    const friend = stringToUuid("transfer-friend");
    const outsider = stringToUuid("transfer-outsider");
    const contact = stringToUuid("transfer-contact");
    const worldId = stringToUuid("transfer-world");
    const roomId = stringToUuid("transfer-room");
    await adapter.createEntities([
      { id: owner, agentId, names: ["Owner"] } as Entity,
      { id: friend, agentId, names: ["Friend"] } as Entity,
      { id: outsider, agentId, names: ["Outsider"] } as Entity,
      { id: contact, agentId, names: ["Contact"] } as Entity,
    ]);
    await adapter.createWorlds([
      {
        id: worldId,
        agentId,
        name: "Transfer world",
        serverId: worldId,
        metadata: {
          ownership: { ownerId: owner },
          roles: { [owner]: "OWNER", [friend]: "USER", [outsider]: "ADMIN" },
        },
      } as World,
    ]);
    await adapter.createRooms([
      {
        id: roomId,
        worldId,
        agentId,
        name: "Transfer room",
        source: "test",
        type: ChannelType.GROUP,
      } as Room,
    ]);
    await adapter.createRoomParticipants([owner, friend], roomId);
    await adapter.createRelationships([
      { sourceEntityId: owner, targetEntityId: contact, tags: ["colleague"] },
    ]);
    const firstId = stringToUuid("transfer-message-1");
    const externalReplyId = stringToUuid("deleted-or-external-message");
    await adapter.createMemories([
      {
        memory: {
          id: firstId,
          agentId,
          entityId: owner,
          roomId,
          worldId,
          content: { text: "first" },
        } as Memory,
        tableName: "messages",
      },
      {
        memory: {
          id: stringToUuid("transfer-message-2"),
          agentId,
          entityId: friend,
          roomId,
          worldId,
          content: { text: "reply", inReplyTo: firstId },
        } as Memory,
        tableName: "messages",
      },
    ]);

    await adapter.createMemories([
      {
        memory: {
          id: stringToUuid("transfer-external-reply"),
          agentId,
          entityId: friend,
          roomId,
          worldId,
          content: {
            text: "reply to external message",
            inReplyTo: externalReplyId,
          },
        } as Memory,
        tableName: "messages",
      },
    ]);

    const bundle = await exportAgent(source.runtime, PASSWORD);
    const imported = await importAgent(target.runtime, bundle, PASSWORD);
    expect(imported.counts.relationships).toBe(1);

    const newAgentId = imported.agentId as UUID;
    if (!target.runtime.adapter.withAgentScope)
      throw new Error("Missing scoped adapter");
    await target.runtime.adapter.withAgentScope(newAgentId, async (db) => {
      const world = (await db.getAllWorlds()).find(
        (row) => row.name === "Transfer world",
      );
      if (!world?.id) throw new Error("imported world missing");
      const [room] = await db.getRoomsByWorlds([world.id]);
      if (!room?.id) throw new Error("imported room missing");
      const entities =
        (await db.getEntitiesForRooms([room.id], true))[0]?.entities ?? [];
      const newOwner = entities.find((entity) =>
        entity.names.includes("Owner"),
      )?.id;
      const newFriend = entities.find((entity) =>
        entity.names.includes("Friend"),
      )?.id;
      if (!newOwner || !newFriend) throw new Error("imported entities missing");
      expect(newOwner).not.toBe(owner);

      const importedRoleIds = Object.keys(
        world.metadata?.roles ?? {},
      ) as UUID[];
      const importedRoleEntities = await db.getEntitiesByIds(importedRoleIds);
      const newOutsider = importedRoleEntities.find((entity) =>
        entity.names.includes("Outsider"),
      )?.id;
      if (!newOutsider) throw new Error("metadata-only entity missing");

      // Ownership and roles name the imported entities, not the source ids.
      expect(world.metadata?.ownership?.ownerId).toBe(newOwner);
      expect(world.metadata?.roles).toEqual({
        [newOwner]: "OWNER",
        [newFriend]: "USER",
        [newOutsider]: "ADMIN",
      });
      expect(entities.some((entity) => entity.names.includes("Outsider"))).toBe(
        false,
      );
      expect(entities.some((entity) => entity.names.includes("Contact"))).toBe(
        false,
      );
      expect(newOutsider).not.toBe(outsider);
      expect(world.metadata?.roles?.[newOutsider]).toBe("ADMIN");

      // The reply names the imported first message.
      const messages = await db.getMemories({
        agentId: newAgentId,
        roomId: room.id,
        tableName: "messages",
      });
      const first = messages.find((memory) => memory.content.text === "first");
      const reply = messages.find((memory) => memory.content.text === "reply");
      expect(first?.id).toBeTruthy();
      expect(reply?.content.inReplyTo).toBe(first?.id as UUID);
      const externalReply = messages.find(
        (memory) => memory.content.text === "reply to external message",
      );
      expect(externalReply?.content.inReplyTo).toBe(externalReplyId);
      expect(messages.some((memory) => memory.id === externalReplyId)).toBe(
        false,
      );

      // The user-to-user relationship arrived with remapped endpoints.
      const relationships = await db.getRelationships({
        entityIds: [newOwner as UUID],
      });
      expect(
        relationships.map((row) => [row.sourceEntityId, row.targetEntityId]),
      ).toHaveLength(1);
      const importedContact = await db.getEntitiesByIds([
        relationships[0].targetEntityId,
      ]);
      expect(importedContact[0]?.names).toContain("Contact");
      expect(importedContact[0]?.id).not.toBe(contact);
      expect(relationships[0].sourceEntityId).toBe(newOwner);
    });
  } finally {
    await source.cleanup();
    await target.cleanup();
  }
}, 300_000);
