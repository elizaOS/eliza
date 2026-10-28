/**
 * The relationship scope of a scheduled-task context request is applied in
 * the store query, not after a capped read: an edge for the requested entity
 * is resolved however many other edges were updated after it.
 * Harness as in subject-store.integration.test.ts.
 */
import {
  KNOWLEDGE_GRAPH_SERVICE,
  KnowledgeGraphService,
} from "@elizaos/plugin-relationships";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.ts";
import { LifeOpsRepository } from "../repository.js";
import { resolveScheduledTaskDispatchContext } from "./dispatch-context.js";

describe("scheduled dispatch relationship context scope", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: RealTestRuntimeResult["runtime"];
  let repo: LifeOpsRepository;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    if (!runtime.getService(KNOWLEDGE_GRAPH_SERVICE)) {
      await runtime.registerService(KnowledgeGraphService);
      await runtime.getServiceLoadPromise(KNOWLEDGE_GRAPH_SERVICE);
    }
    await LifeOpsRepository.bootstrapSchema(runtime);
    repo = new LifeOpsRepository(runtime);
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("resolves the requested entity's edge behind a hundred more recently updated edges", async () => {
    const entities = await repo.entityStore(runtime.agentId);
    const relationships = await repo.relationshipStore(runtime.agentId);
    const person = async (name: string) =>
      entities.upsert({
        type: "person",
        preferredName: name,
        identities: [],
        tags: [],
        visibility: "owner_agent_admin",
        state: {},
      });
    const mom = await person("Mom");
    const owner = await person("Owner");
    const target = await relationships.upsert({
      fromEntityId: owner.entityId,
      toEntityId: mom.entityId,
      type: "parent_of",
      metadata: {},
      state: { lastInteractionAt: "2026-01-01T00:00:00.000Z" },
      evidence: ["seed"],
      confidence: 0.95,
      source: "user_chat",
    });
    for (let index = 0; index < 100; index += 1) {
      const a = await person(`Contact A${index}`);
      const b = await person(`Contact B${index}`);
      await relationships.upsert({
        fromEntityId: a.entityId,
        toEntityId: b.entityId,
        type: "colleague_of",
        metadata: {},
        state: {},
        evidence: ["seed"],
        confidence: 0.5,
        source: "user_chat",
      });
    }
    const record = {
      taskId: "task-relationship-scope",
      firedAtIso: new Date().toISOString(),
      channelKey: "test",
      promptInstructions: "Remind the owner to call Mom.",
      contextRequest: {
        includeRelationships: { forEntityIds: [mom.entityId] },
      },
    } as Parameters<typeof resolveScheduledTaskDispatchContext>[1];

    const byEntity = await resolveScheduledTaskDispatchContext(runtime, record);
    expect(byEntity?.relationships?.map((r) => r.relationshipId)).toEqual([
      target.relationshipId,
    ]);

    const byType = await resolveScheduledTaskDispatchContext(runtime, {
      ...record,
      contextRequest: { includeRelationships: { types: ["parent_of"] } },
    } as typeof record);
    expect(byType?.relationships?.map((r) => r.relationshipId)).toEqual([
      target.relationshipId,
    ]);

    const mismatch = await resolveScheduledTaskDispatchContext(runtime, {
      ...record,
      contextRequest: {
        includeRelationships: {
          forEntityIds: [mom.entityId],
          types: ["colleague_of"],
        },
      },
    } as typeof record);
    expect(mismatch?.relationships).toEqual([]);
  }, 180_000);

  it("refuses a scope that resolves past the lookup boundary instead of trimming it", async () => {
    const entities = await repo.entityStore(runtime.agentId);
    const relationships = await repo.relationshipStore(runtime.agentId);
    const hub = await entities.upsert({
      type: "person",
      preferredName: "Hub",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    for (let index = 0; index <= 100; index += 1) {
      const spoke = await entities.upsert({
        type: "person",
        preferredName: `Spoke ${index}`,
        identities: [],
        tags: [],
        visibility: "owner_agent_admin",
        state: {},
      });
      await relationships.upsert({
        fromEntityId: hub.entityId,
        toEntityId: spoke.entityId,
        type: "knows",
        metadata: {},
        state: {},
        evidence: ["seed"],
        confidence: 0.5,
        source: "user_chat",
      });
    }
    const record = {
      taskId: "task-relationship-boundary",
      firedAtIso: new Date().toISOString(),
      channelKey: "test",
      promptInstructions: "Summarize the hub's contacts.",
      contextRequest: {
        includeRelationships: { forEntityIds: [hub.entityId] },
      },
    } as Parameters<typeof resolveScheduledTaskDispatchContext>[1];
    await expect(
      resolveScheduledTaskDispatchContext(runtime, record),
    ).rejects.toMatchObject({
      code: "SCHEDULED_DISPATCH_CONTEXT_LIMIT_EXCEEDED",
    });
  }, 180_000);
});
