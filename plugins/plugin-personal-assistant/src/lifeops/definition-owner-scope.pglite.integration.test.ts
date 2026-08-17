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

const OWNER_A = "11111111-1111-4111-8111-111111111111";
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
    windowPolicy: { timezone: "UTC", windows: [] },
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
  let agentId: string;
  let defA: LifeOpsTaskDefinition;
  let defB: LifeOpsTaskDefinition;

  beforeAll(async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    agentId = runtimeResult.runtime.agentId;
    repository = new LifeOpsRepository(runtimeResult.runtime);
    // Duplicate titles on purpose: title text must never disambiguate owners.
    defA = makeDefinition(agentId, OWNER_A, "water the plants");
    defB = makeDefinition(agentId, OWNER_B, "water the plants");
    await repository.createDefinition(defA);
    await repository.createDefinition(defB);
  }, 120_000);

  afterAll(async () => {
    await runtimeResult?.cleanup();
  });

  it("scoped list returns only the requesting owner's definitions", async () => {
    const forA = await repository.listDefinitions(agentId, {
      subjectType: "owner",
      subjectId: OWNER_A,
    });
    expect(forA.map((d) => d.id)).toEqual([defA.id]);
    const forB = await repository.listDefinitions(agentId, {
      subjectType: "owner",
      subjectId: OWNER_B,
    });
    expect(forB.map((d) => d.id)).toEqual([defB.id]);
    const activeForA = await repository.listActiveDefinitions(agentId, {
      subjectType: "owner",
      subjectId: OWNER_A,
    });
    expect(activeForA.map((d) => d.id)).toEqual([defA.id]);
  });

  it("scoped get denies cross-owner reads by id", async () => {
    const crossRead = await repository.getDefinition(agentId, defB.id, {
      subjectType: "owner",
      subjectId: OWNER_A,
    });
    expect(crossRead).toBeNull();
    const ownRead = await repository.getDefinition(agentId, defB.id, {
      subjectType: "owner",
      subjectId: OWNER_B,
    });
    expect(ownRead?.id).toBe(defB.id);
  });

  it("update cannot land on another owner's row even with the victim's id", async () => {
    const forged: LifeOpsTaskDefinition = {
      ...defB,
      subjectId: OWNER_A,
      title: "hijacked",
      updatedAt: new Date().toISOString(),
    };
    await expectConflict(repository.updateDefinition(forged));
    const untouched = await repository.getDefinition(agentId, defB.id);
    expect(untouched?.title).toBe("water the plants");
    expect(untouched?.subjectId).toBe(OWNER_B);
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
        scope: { subjectType: "owner", subjectId: OWNER_A },
      }),
    );
    expect(await repository.getDefinition(agentId, defB.id)).not.toBeNull();
  });

  it("delete with a stale revision conflicts; the fresh revision deletes exactly once", async () => {
    const current = await repository.getDefinition(agentId, defB.id);
    if (!current) throw new Error("definition B missing");
    await expectConflict(
      repository.deleteDefinition(agentId, defB.id, {
        scope: { subjectType: "owner", subjectId: OWNER_B },
        expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
      }),
    );
    await repository.deleteDefinition(agentId, defB.id, {
      scope: { subjectType: "owner", subjectId: OWNER_B },
      expectedUpdatedAt: current.updatedAt,
    });
    expect(await repository.getDefinition(agentId, defB.id)).toBeNull();
    // A repeated delete (retry after success) must conflict, not fabricate success.
    await expectConflict(
      repository.deleteDefinition(agentId, defB.id, {
        scope: { subjectType: "owner", subjectId: OWNER_B },
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
      subjectType: "owner",
      subjectId: OWNER_A,
    });
    expect(survivors.map((d) => d.id)).toEqual([defA.id]);
  });
});
