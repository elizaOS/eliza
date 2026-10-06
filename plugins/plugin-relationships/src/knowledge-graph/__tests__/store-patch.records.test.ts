/**
 * EntityStore.patch and RelationshipStore.patch on the durable-record path (a
 * real in-memory SQLite runtime): the mutation receives the current record,
 * so a write made after an earlier read is merged, not reverted.
 */

import { AgentRuntime } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { expect, it } from "vitest";
import { EntityStore } from "../entity-store.ts";
import { RelationshipStore } from "../relationship-store.ts";

async function runtime() {
  const agent = new AgentRuntime({
    character: { name: "Graph", bio: ["test"] },
    logLevel: "fatal",
  });
  agent.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(":memory:", agent.agentId),
  );
  await agent.adapter.initialize();
  return agent;
}

it("patches the current entity and relationship, not an earlier read", async () => {
  const agent = await runtime();
  const entities = new EntityStore(agent, agent.agentId);
  const relationships = new RelationshipStore(agent, agent.agentId);
  const entity = await entities.upsert({
    type: "person",
    preferredName: "Pat",
    identities: [],
    state: {},
    tags: [],
    visibility: "owner_agent_admin",
  });
  const stale = await entities.get(entity.entityId);
  await entities.upsert({ ...entity, tags: ["met-at-conf"] });

  const patched = await entities.patch(entity.entityId, (current) => ({
    ...current,
    preferredName: "Patricia",
  }));

  expect(stale?.tags).toEqual([]);
  expect(patched).toMatchObject({
    preferredName: "Patricia",
    tags: ["met-at-conf"],
  });
  expect(await entities.patch("ent_missing", (current) => current)).toBeNull();

  const edge = await relationships.upsert({
    fromEntityId: "self",
    toEntityId: entity.entityId,
    type: "knows",
    state: {},
    evidence: [],
    confidence: 0.5,
    source: "user_chat",
  });
  await relationships.observe({
    fromEntityId: "self",
    toEntityId: entity.entityId,
    type: "knows",
    evidence: [],
    confidence: 0.5,
  });
  const patchedEdge = await relationships.patch(
    edge.relationshipId,
    (current) => ({
      ...current,
      confidence: 0.9,
    }),
  );

  expect(patchedEdge?.confidence).toBe(0.9);
  expect(patchedEdge?.state.interactionCount).toBe(1);
  expect(
    await relationships.patch("rel_missing", (current) => current),
  ).toBeNull();
});
