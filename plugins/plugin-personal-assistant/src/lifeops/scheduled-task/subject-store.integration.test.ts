/**
 * `createLifeOpsSubjectStoreView` — real-store coverage.
 *
 * The previous wiring injected a warn-once `false` shim, so `subject_updated`
 * completion-checks could never pass. This suite exercises the production
 * view against the genuine stores on a PGLite-backed runtime:
 * entity/relationship rows via the registered `KnowledgeGraphService`, work
 * threads via `LifeOpsRepository`, and the honest not-updated answers for
 * missing rows and still-unbound kinds (document / calendar_event / self).
 */

import { KNOWLEDGE_GRAPH_SERVICE, KnowledgeGraphService } from "@elizaos/agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../../test/helpers/runtime.ts";
import { LifeOpsRepository } from "../repository.js";
import { createLifeOpsSubjectStoreView } from "./subject-store.js";

const PAST = "2020-01-01T00:00:00.000Z";
const FAR_FUTURE = "2100-01-01T00:00:00.000Z";

describe("createLifeOpsSubjectStoreView — real stores", () => {
  let runtimeResult: RealTestRuntimeResult;
  let runtime: RealTestRuntimeResult["runtime"];
  let view: ReturnType<typeof createLifeOpsSubjectStoreView>;
  let repo: LifeOpsRepository;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    runtime = runtimeResult.runtime;
    await runtime.registerService(KnowledgeGraphService);
    await runtime.getServiceLoadPromise(KNOWLEDGE_GRAPH_SERVICE);
    await LifeOpsRepository.bootstrapSchema(runtime);
    repo = new LifeOpsRepository(runtime);
    view = createLifeOpsSubjectStoreView(runtime, runtime.agentId);
  }, 180_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("entity: answers from the real life_entities row's updatedAt", async () => {
    const store = await repo.entityStore(runtime.agentId);
    const entity = await store.upsert({
      type: "person",
      preferredName: "Alice",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });

    expect(
      await view.wasUpdatedSince({
        subject: { kind: "entity", id: entity.entityId },
        sinceIso: PAST,
      }),
    ).toBe(true);
    expect(
      await view.wasUpdatedSince({
        subject: { kind: "entity", id: entity.entityId },
        sinceIso: FAR_FUTURE,
      }),
    ).toBe(false);
  });

  it("entity: a missing row is honest not-updated, not an error", async () => {
    expect(
      await view.wasUpdatedSince({
        subject: { kind: "entity", id: "ent_does_not_exist" },
        sinceIso: PAST,
      }),
    ).toBe(false);
  });

  it("relationship: a logged interaction newer than updatedAt counts as an update", async () => {
    const entities = await repo.entityStore(runtime.agentId);
    const alice = await entities.upsert({
      type: "person",
      preferredName: "Alice",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    const bob = await entities.upsert({
      type: "person",
      preferredName: "Bob",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });

    const interactionAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const relationships = await repo.relationshipStore(runtime.agentId);
    const edge = await relationships.upsert({
      fromEntityId: alice.entityId,
      toEntityId: bob.entityId,
      type: "colleague_of",
      metadata: {},
      state: { lastInteractionAt: interactionAt },
      evidence: ["seed"],
      confidence: 0.9,
      source: "user_chat",
    });

    // updatedAt (row write time) is before this cutoff, but the recorded
    // interaction is after it — the followup-resolving signal.
    const betweenIso = new Date(Date.now() + 5 * 60_000).toISOString();
    expect(
      await view.wasUpdatedSince({
        subject: { kind: "relationship", id: edge.relationshipId },
        sinceIso: betweenIso,
      }),
    ).toBe(true);
    expect(
      await view.wasUpdatedSince({
        subject: { kind: "relationship", id: edge.relationshipId },
        sinceIso: FAR_FUTURE,
      }),
    ).toBe(false);
  });

  it("thread: answers from the real work-thread row's updatedAt/lastActivityAt", async () => {
    const nowIso = new Date().toISOString();
    const threadId = `wt_subject_${Math.random().toString(36).slice(2, 8)}`;
    await repo.upsertWorkThread(runtime.agentId, {
      id: threadId,
      agentId: runtime.agentId,
      status: "active",
      title: "Renew passport",
      summary: "Waiting on the appointment slot.",
      primarySourceRef: { connector: "in_app" },
      sourceRefs: [],
      participantEntityIds: [],
      version: 1,
      createdAt: nowIso,
      updatedAt: nowIso,
      lastActivityAt: nowIso,
    });

    expect(
      await view.wasUpdatedSince({
        subject: { kind: "thread", id: threadId },
        sinceIso: PAST,
      }),
    ).toBe(true);
    expect(
      await view.wasUpdatedSince({
        subject: { kind: "thread", id: threadId },
        sinceIso: FAR_FUTURE,
      }),
    ).toBe(false);
    expect(
      await view.wasUpdatedSince({
        subject: { kind: "thread", id: "wt_missing" },
        sinceIso: PAST,
      }),
    ).toBe(false);
  });

  it("unbound kinds (document / calendar_event / self) report not-updated", async () => {
    for (const kind of ["document", "calendar_event", "self"] as const) {
      expect(
        await view.wasUpdatedSince({
          subject: { kind, id: "any" },
          sinceIso: PAST,
        }),
      ).toBe(false);
    }
  });

  it("an unparseable sinceIso never counts as updated", async () => {
    const store = await repo.entityStore(runtime.agentId);
    const entity = await store.upsert({
      type: "person",
      preferredName: "Carol",
      identities: [],
      tags: [],
      visibility: "owner_agent_admin",
      state: {},
    });
    expect(
      await view.wasUpdatedSince({
        subject: { kind: "entity", id: entity.entityId },
        sinceIso: "not-a-date",
      }),
    ).toBe(false);
  });
});
