/**
 * RelationshipStore's cadence-overdue listing on the durable-record path (a
 * real in-memory SQLite runtime, whose adapter supplies `recordStore`): the
 * limit counts overdue edges, so it applies after the overdue filter.
 */

import { AgentRuntime } from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/plugin-sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RelationshipStore } from "../relationship-store.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

it("returns the stale overdue edge behind fresher edges when limited", async () => {
  const runtime = new AgentRuntime({
    character: { name: "Relationships", bio: ["test"] },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(":memory:", runtime.agentId),
  );
  await runtime.adapter.initialize();
  const store = new RelationshipStore(runtime, runtime.agentId);
  const edge = (
    relationshipId: string,
    toEntityId: string,
    lastInteractionAt: string,
  ) =>
    store.upsert({
      relationshipId,
      fromEntityId: "self",
      toEntityId,
      type: "knows",
      metadata: { cadenceDays: 7 },
      state: { lastInteractionAt },
      evidence: [],
      confidence: 0.5,
      source: "user_chat",
    });
  vi.setSystemTime(new Date("2026-06-01T12:00:00.000Z"));
  await edge("rel_overdue", "ent_old_friend", "2026-05-01T12:00:00.000Z");
  for (const [index, toEntityId] of ["ent_a", "ent_b", "ent_c"].entries()) {
    vi.setSystemTime(new Date(`2026-06-01T12:00:0${index + 1}.000Z`));
    await edge(`rel_fresh_${index}`, toEntityId, "2026-05-31T12:00:00.000Z");
  }

  const overdue = await store.list({
    cadenceOverdueAsOf: "2026-06-01T12:00:00.000Z",
    limit: 2,
  });

  expect(overdue.map((rel) => rel.relationshipId)).toEqual(["rel_overdue"]);
});
