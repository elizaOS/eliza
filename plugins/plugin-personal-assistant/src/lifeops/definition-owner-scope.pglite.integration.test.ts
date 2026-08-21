/**
 * Real-PGlite coverage for owner-identity scoping and optimistic concurrency
 * at the LifeOps definition persistence boundary (#17398): two owner subjects
 * under one agent must never list, update, or delete each other's definitions,
 * and stale mutations must surface as a typed LIFEOPS_DEFINITION_CONFLICT.
 * The harness is a real AgentRuntime with the personal-assistant plugin's
 * schema migrated into PGlite — no mocked repository.
 */
import { ElizaError } from "@elizaos/core";
import type { LifeOpsTaskDefinition } from "@elizaos/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import {
  createLifeOpsTaskDefinition,
  LifeOpsRepository,
} from "./repository.js";
import { LifeOpsService } from "./service.js";

const OWNER_B = "22222222-2222-4222-8222-222222222222";

function makeDefinition(
  agentId: string,
  subjectId: string,
  title: string,
): LifeOpsTaskDefinition {
  return createLifeOpsTaskDefinition({
    agentId,
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId,
    visibilityScope: "owner_only",
    contextPolicy: "explicit_only",
    kind: "task",
    title,
    description: "",
    originalIntent: title,
    timezone: "UTC",
    status: "active",
    priority: 3,
    cadence: { kind: "once", dueAt: "2027-01-05T09:00:00.000Z" },
    windowPolicy: {
      timezone: "UTC",
      windows: [
        {
          name: "morning",
          label: "Morning",
          startMinute: 480,
          endMinute: 720,
        },
      ],
    },
    progressionRule: { kind: "none" },
    websiteAccess: null,
    reminderPlanId: null,
    goalId: null,
    source: "manual",
    metadata: {},
  });
}

async function expectConflict(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof ElizaError &&
      error.code === "LIFEOPS_DEFINITION_CONFLICT",
  );
}

describe("LifeOps definition persistence — owner scope and revision predicates", () => {
  let runtimeResult: RealTestRuntimeResult;
  let repository: LifeOpsRepository;
  let service: LifeOpsService;
  let agentId: string;
  let ownerA: string;
  let defA: LifeOpsTaskDefinition;
  let defB: LifeOpsTaskDefinition;
  let crossDomain: LifeOpsTaskDefinition;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    agentId = runtimeResult.runtime.agentId;
    repository = new LifeOpsRepository(runtimeResult.runtime);
    service = new LifeOpsService(runtimeResult.runtime);
    ownerA = service.ownerEntityId();
    // Duplicate titles on purpose: title text must never disambiguate owners.
    defA = makeDefinition(agentId, ownerA, "water the plants");
    defB = makeDefinition(agentId, OWNER_B, "water the plants");
    crossDomain = {
      ...makeDefinition(agentId, ownerA, "cross-domain poison"),
      domain: "agent_ops",
    };
    await repository.createDefinition(defA);
    await repository.createDefinition(defB);
    await repository.createDefinition(crossDomain);
  }, 120_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("scoped list returns only the requesting owner's definitions", async () => {
    const forA = await repository.listDefinitions(agentId, {
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: ownerA,
    });
    expect(forA.map((d) => d.id)).toEqual([defA.id]);
    const forB = await repository.listDefinitions(agentId, {
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: OWNER_B,
    });
    expect(forB.map((d) => d.id)).toEqual([defB.id]);
    const activeForA = await repository.listActiveDefinitions(agentId, {
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: ownerA,
    });
    expect(activeForA.map((d) => d.id)).toEqual([defA.id]);
  });

  it("scoped get denies cross-owner reads by id", async () => {
    const crossRead = await repository.getDefinition(agentId, defB.id, {
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: ownerA,
    });
    expect(crossRead).toBeNull();
    const ownRead = await repository.getDefinition(agentId, defB.id, {
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: OWNER_B,
    });
    expect(ownRead?.id).toBe(defB.id);
  });

  it("update cannot land on another owner's row even with the victim's id", async () => {
    const forged: LifeOpsTaskDefinition = {
      ...defB,
      subjectId: ownerA,
      title: "hijacked",
      updatedAt: new Date().toISOString(),
    };
    await expectConflict(repository.updateDefinition(forged));
    const untouched = await repository.getDefinition(agentId, defB.id);
    expect(untouched?.title).toBe("water the plants");
    expect(untouched?.subjectId).toBe(OWNER_B);
  });

  it("domain is part of read and mutation identity", async () => {
    const ownerDefinitions = await repository.listDefinitions(agentId, {
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: ownerA,
    });
    expect(ownerDefinitions.map((definition) => definition.id)).toEqual([
      defA.id,
    ]);
    expect(
      await repository.getDefinition(agentId, crossDomain.id, {
        domain: "user_lifeops",
        subjectType: "owner",
        subjectId: ownerA,
      }),
    ).toBeNull();
    await expectConflict(
      repository.updateDefinition({
        ...crossDomain,
        domain: "user_lifeops",
        title: "cross-domain overwrite",
      }),
    );
    await expectConflict(
      repository.deleteDefinition(agentId, crossDomain.id, {
        scope: {
          domain: "user_lifeops",
          subjectType: "owner",
          subjectId: ownerA,
        },
      }),
    );
    expect(
      await repository.getDefinition(agentId, crossDomain.id),
    ).not.toBeNull();
  });

  it("production service list/get/update/delete deny foreign subject and domain rows", async () => {
    const visible = await service.listDefinitions();
    expect(visible.map((record) => record.definition.id)).toEqual([defA.id]);
    for (const hiddenId of [defB.id, crossDomain.id]) {
      await expect(service.getDefinition(hiddenId)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        service.updateDefinition(hiddenId, { title: "unauthorized" }),
      ).rejects.toMatchObject({ status: 404 });
      await expect(service.deleteDefinition(hiddenId)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        service.getReminderPreference(hiddenId),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        service.setReminderPreference({
          definitionId: hiddenId,
          intensity: "normal",
        }),
      ).rejects.toMatchObject({ status: 404 });
      expect(await repository.getDefinition(agentId, hiddenId)).not.toBeNull();
    }
  });

  it("moves a caller-owned definition between supported domains atomically", async () => {
    const movable = makeDefinition(agentId, ownerA, "move between domains");
    await repository.createDefinition(movable);
    const moved = await service.updateDefinition(movable.id, {
      ownership: {
        domain: "agent_ops",
        subjectType: "agent",
        subjectId: agentId,
      },
    });
    expect(moved.definition).toMatchObject({
      domain: "agent_ops",
      subjectType: "agent",
      subjectId: agentId,
    });
    await expect(
      repository.getDefinition(agentId, movable.id, {
        domain: "user_lifeops",
        subjectType: "owner",
        subjectId: ownerA,
      }),
    ).resolves.toBeNull();
    await expect(
      repository.getDefinition(agentId, movable.id, {
        domain: "agent_ops",
        subjectType: "agent",
        subjectId: agentId,
      }),
    ).resolves.toMatchObject({ id: movable.id });
    await repository.deleteDefinition(agentId, movable.id, {
      scope: {
        domain: "agent_ops",
        subjectType: "agent",
        subjectId: agentId,
      },
      expectedUpdatedAt: moved.definition.updatedAt,
    });
  });

  it("denies occurrence mutation and reminder inspection for a hidden definition", async () => {
    const now = new Date("2027-01-05T08:30:00.000Z");
    const occurrences = await service.refreshDefinitionOccurrences(
      crossDomain,
      now,
    );
    expect(occurrences).toHaveLength(1);
    const occurrence = occurrences[0];

    const callerScope = {
      domain: "user_lifeops" as const,
      subjectType: "owner" as const,
      subjectId: ownerA,
    };
    await expect(
      repository.getOccurrence(agentId, occurrence.id, callerScope),
    ).resolves.toBeNull();
    await expect(
      repository.getOccurrenceView(agentId, occurrence.id, callerScope),
    ).resolves.toBeNull();
    await expect(
      repository.listOccurrenceViewsForOverview(
        agentId,
        "2027-01-06T00:00:00.000Z",
        [callerScope],
      ),
    ).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: occurrence.id })]),
    );

    await expect(
      service.completeOccurrence(occurrence.id, {}, now),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.inspectReminder("occurrence", occurrence.id),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.acknowledgeReminder({
        ownerType: "occurrence",
        ownerId: occurrence.id,
        note: "must remain private",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      repository.getOccurrence(agentId, occurrence.id),
    ).resolves.toMatchObject({ state: "pending", metadata: {} });
    const overview = await service.getOverview(now);
    expect(overview.owner.occurrences.map((item) => item.id)).not.toContain(
      occurrence.id,
    );
    expect(overview.agentOps.occurrences.map((item) => item.id)).not.toContain(
      occurrence.id,
    );
  });

  it("rejects a stale occurrence mutation after its agent definition moves to another owner", async () => {
    const now = new Date("2027-01-05T08:30:00.000Z");
    const ownerBService = new LifeOpsService(runtimeResult.runtime, {
      ownerEntityId: OWNER_B,
    });
    const sharedDefinition: LifeOpsTaskDefinition = {
      ...makeDefinition(agentId, agentId, "shared agent task"),
      domain: "agent_ops",
      subjectType: "agent",
      subjectId: agentId,
      visibilityScope: "agent_and_admin",
      contextPolicy: "never",
    };
    await repository.createDefinition(sharedDefinition);
    const [occurrence] = await service.refreshDefinitionOccurrences(
      sharedDefinition,
      now,
    );
    if (!occurrence) throw new Error("expected shared occurrence");

    // Completion writes go through the scope-guarded atomic transition, so
    // the ownership move is injected immediately before that write lands.
    const originalComplete =
      service.repository.completeOccurrenceIfNonTerminal.bind(
        service.repository,
      );
    service.repository.completeOccurrenceIfNonTerminal = async (
      candidate,
      options,
    ) => {
      await ownerBService.updateDefinition(sharedDefinition.id, {
        ownership: {
          domain: "user_lifeops",
          subjectType: "owner",
          subjectId: OWNER_B,
        },
      });
      return originalComplete(candidate, options);
    };

    try {
      await expect(
        service.completeOccurrence(occurrence.id, {}, now),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof ElizaError &&
          error.code === "LIFEOPS_OCCURRENCE_CONFLICT",
      );
    } finally {
      service.repository.completeOccurrenceIfNonTerminal = originalComplete;
    }
    const persisted = await repository.getOccurrence(agentId, occurrence.id);
    expect(persisted).toMatchObject({
      state: "pending",
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: OWNER_B,
    });
  });

  it("keeps another owner's completed items out of owner recaps", async () => {
    const now = new Date("2027-01-05T10:00:00.000Z");
    const ownDefinition = makeDefinition(agentId, ownerA, "owner A completed");
    const foreignDefinition = makeDefinition(
      agentId,
      OWNER_B,
      "owner B private completion",
    );
    await repository.createDefinition(ownDefinition);
    await repository.createDefinition(foreignDefinition);

    const [ownOccurrence] = await service.refreshDefinitionOccurrences(
      ownDefinition,
      now,
    );
    const [foreignOccurrence] = await service.refreshDefinitionOccurrences(
      foreignDefinition,
      now,
    );
    if (!ownOccurrence || !foreignOccurrence) {
      throw new Error("expected both owner occurrences to materialize");
    }
    await repository.updateOccurrence({
      ...ownOccurrence,
      state: "completed",
      updatedAt: now.toISOString(),
    });
    await repository.updateOccurrence({
      ...foreignOccurrence,
      state: "completed",
      updatedAt: now.toISOString(),
    });

    const completed = await service.listOwnerOccurrencesCompletedToday(now);
    expect(completed.map((item) => item.id)).toContain(ownOccurrence.id);
    expect(completed.map((item) => item.id)).not.toContain(
      foreignOccurrence.id,
    );
    expect(completed.map((item) => item.title)).not.toContain(
      foreignDefinition.title,
    );
    await repository.deleteDefinition(agentId, ownDefinition.id, {
      scope: {
        domain: "user_lifeops",
        subjectType: "owner",
        subjectId: ownerA,
      },
      expectedUpdatedAt: ownDefinition.updatedAt,
    });
    await repository.deleteDefinition(agentId, foreignDefinition.id, {
      scope: {
        domain: "user_lifeops",
        subjectType: "owner",
        subjectId: OWNER_B,
      },
      expectedUpdatedAt: foreignDefinition.updatedAt,
    });
  });

  it("stale expectedUpdatedAt yields a typed conflict and leaves the row intact", async () => {
    const before = await repository.getDefinition(agentId, defA.id);
    if (!before) throw new Error("definition A missing");
    const firstWrite: LifeOpsTaskDefinition = {
      ...before,
      title: "water the plants (am)",
      updatedAt: new Date(Date.now() + 1000).toISOString(),
    };
    await repository.updateDefinition(firstWrite, {
      expectedUpdatedAt: before.updatedAt,
    });
    // Second writer computed from the pre-update revision must conflict.
    const staleWrite: LifeOpsTaskDefinition = {
      ...before,
      title: "stale overwrite",
      updatedAt: new Date(Date.now() + 2000).toISOString(),
    };
    await expectConflict(
      repository.updateDefinition(staleWrite, {
        expectedUpdatedAt: before.updatedAt,
      }),
    );
    const after = await repository.getDefinition(agentId, defA.id);
    expect(after?.title).toBe("water the plants (am)");
  });

  it("delete scoped to another owner conflicts and cascades nothing", async () => {
    await expectConflict(
      repository.deleteDefinition(agentId, defB.id, {
        scope: {
          domain: "user_lifeops",
          subjectType: "owner",
          subjectId: ownerA,
        },
      }),
    );
    expect(await repository.getDefinition(agentId, defB.id)).not.toBeNull();
  });

  it("delete with a stale revision conflicts; the fresh revision deletes exactly once", async () => {
    const current = await repository.getDefinition(agentId, defB.id);
    if (!current) throw new Error("definition B missing");
    await expectConflict(
      repository.deleteDefinition(agentId, defB.id, {
        scope: {
          domain: "user_lifeops",
          subjectType: "owner",
          subjectId: OWNER_B,
        },
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    await repository.deleteDefinition(agentId, defB.id, {
      scope: {
        domain: "user_lifeops",
        subjectType: "owner",
        subjectId: OWNER_B,
      },
      expectedUpdatedAt: current.updatedAt,
    });
    expect(await repository.getDefinition(agentId, defB.id)).toBeNull();
    // A repeated delete (retry after success) must conflict, not fabricate success.
    await expectConflict(
      repository.deleteDefinition(agentId, defB.id, {
        scope: {
          domain: "user_lifeops",
          subjectType: "owner",
          subjectId: OWNER_B,
        },
        expectedUpdatedAt: current.updatedAt,
      }),
    );
    // An update raced against the completed delete conflicts the same way.
    await expectConflict(
      repository.updateDefinition(
        { ...current, title: "post-delete write" },
        { expectedUpdatedAt: current.updatedAt },
      ),
    );
    // Owner A's duplicate-titled definition is untouched by B's delete.
    const survivors = await repository.listDefinitions(agentId, {
      domain: "user_lifeops",
      subjectType: "owner",
      subjectId: ownerA,
    });
    expect(survivors.map((d) => d.id)).toEqual([defA.id]);
  });
});
