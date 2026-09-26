import { ChannelType, type Memory, type UUID } from "@elizaos/core";
import { expect, it } from "vitest";
import { createIsolatedTestDatabase } from "../../../plugin-sql/src/__tests__/test-helpers.ts";
import { applyAddressedTo } from "./addressed-to.ts";

it("adds addressed evidence to the existing SQL relationship without replacing its identity", async () => {
  const { runtime, cleanup } = await createIsolatedTestDatabase(
    "addressed-pair",
    [],
    { postgresUrl: null },
  );
  const speaker = "20000000-0000-4000-8000-000000000001" as UUID;
  const target = "20000000-0000-4000-8000-000000000002" as UUID;
  const room = "20000000-0000-4000-8000-000000000003" as UUID;
  try {
    await runtime.createRoom({
      id: room,
      worldId: room,
      name: "room",
      source: "test",
      type: ChannelType.GROUP,
    });
    await runtime.createEntities([
      { id: speaker, agentId: runtime.agentId, names: ["speaker"] },
      { id: target, agentId: runtime.agentId, names: ["target"] },
    ]);
    await runtime.createRoomParticipants([speaker, target], room);
    await runtime.createRelationship({
      sourceEntityId: speaker,
      targetEntityId: target,
      tags: ["friend"],
      metadata: { note: "preserve" },
    });
    const pair = { sourceEntityId: speaker, targetEntityId: target };
    const before = await runtime.getRelationship(pair);
    for (let turn = 0; turn < 2; turn++) {
      expect(
        await applyAddressedTo({
          runtime,
          message: {
            agentId: runtime.agentId,
            entityId: speaker,
            roomId: room,
            content: { text: "target, hello" },
          } as Memory,
          addressedTo: ["target"],
        }),
      ).toEqual({ created: 0, updated: 1, resolved: [target] });
    }
    const after = await runtime.getRelationship(pair);
    expect(after?.id).toBe(before?.id);
    expect(after?.tags).toEqual(["friend", "addressed", "addressed:auto"]);
    expect(after?.metadata).toMatchObject({
      note: "preserve",
      source: "message_handler_addressedTo",
    });
    expect(
      await runtime.getRelationships({ entityIds: [speaker] }),
    ).toHaveLength(1);
  } finally {
    await cleanup();
  }
});
