import type { IAgentRuntime, Memory, UUID } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { expect, it } from "vitest";
import { applyAddressedTo, resolveAddressedTargets } from "./addressed-to.ts";

it("resolves stored handles without allowing a participant to shadow the agent", async () => {
  const agentId = "11111111-1111-4111-8111-111111111111" as UUID;
  const participantId = "22222222-2222-4222-8222-222222222222" as UUID;
  for (const reverse of [false, true]) {
    const entities = [
      { id: agentId, names: ["@eliza_bot"] },
      { id: participantId, names: [" @sol_eth ", "@Eliza", "@"] },
    ];
    if (reverse) entities.reverse();
    const runtime = {
      agentId,
      character: { name: "Eliza" },
      getEntitiesForRoom: async () => entities,
    } as unknown as IAgentRuntime;
    const message = {
      roomId: "33333333-3333-4333-8333-333333333333",
      content: {},
    } as Memory;
    for (const name of ["sol_eth", "@sol_eth", " @sol_eth "]) {
      expect(
        await resolveAddressedTargets({
          runtime,
          message,
          addressedTo: [name],
        }),
      ).toEqual([participantId]);
    }
    for (const name of ["Eliza", "@Eliza", "eliza_bot", "@eliza_bot"]) {
      expect(
        await resolveAddressedTargets({
          runtime,
          message,
          addressedTo: [name],
        }),
      ).toEqual([agentId]);
    }
    expect(
      await resolveAddressedTargets({ runtime, message, addressedTo: ["@"] }),
    ).toEqual([]);
  }
});

it("adds addressed evidence to the existing friendship without duplicating the pair", async () => {
  const agentId = "11111111-1111-4111-8111-111111111111" as UUID;
  const speakerId = "22222222-2222-4222-8222-222222222222" as UUID;
  const targetId = "33333333-3333-4333-8333-333333333333" as UUID;
  const adapter = SQLiteDatabaseAdapter.create(":memory:", agentId);
  try {
    const [id] = await adapter.createRelationships([
      {
        sourceEntityId: speakerId,
        targetEntityId: targetId,
        tags: ["friend"],
        metadata: { retained: "prior evidence" },
      },
    ]);
    const runtime = {
      agentId,
      character: { name: "Eliza" },
      getEntitiesForRoom: async () => [{ id: targetId, names: ["Sam"] }],
      getRelationships: adapter.getRelationships.bind(adapter),
      updateRelationship: async (relationship) =>
        adapter.updateRelationships([relationship]),
      createRelationship: async (relationship) =>
        Boolean((await adapter.createRelationships([relationship])).length),
      getService: () => null,
    } as IAgentRuntime;
    const args = {
      runtime,
      message: { entityId: speakerId, roomId: agentId } as Memory,
      addressedTo: ["Sam"],
    };
    expect(await applyAddressedTo(args)).toMatchObject({
      created: 0,
      updated: 1,
      resolved: [targetId],
    });
    expect(await applyAddressedTo(args)).toMatchObject({
      created: 0,
      updated: 1,
    });
    const rows = await adapter.getRelationships({ entityIds: [speakerId] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id,
      tags: ["friend", "addressed", "addressed:auto"],
      metadata: { retained: "prior evidence" },
    });
  } finally {
    await adapter.close();
  }
});
