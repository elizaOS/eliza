/**
 * Exercises definition ownership, optimistic concurrency, and durable mutation
 * retries against the production LifeOps repository on real PGlite.
 */
import type { HandlerOptions, Memory } from "@elizaos/core";
import { afterEach, describe, expect, it } from "vitest";
import { runLifeOperationHandler } from "../src/actions/life.ts";
import {
  createLifeOpsTaskDefinition,
  type LifeOpsDefinitionScope,
  LifeOpsRepository,
} from "../src/lifeops/repository.ts";
import { LifeOpsService } from "../src/lifeops/service.ts";
import { OptimisticLockError } from "../src/lifeops/sql.ts";
import type { RealTestRuntimeResult } from "./helpers/runtime.ts";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

const OWNER_A = "00000000-0000-0000-0000-0000000000a1";
const OWNER_B = "00000000-0000-0000-0000-0000000000b2";
const ROOM_ID = "00000000-0000-0000-0000-0000000000c3";

function ownerScope(agentId: string, ownerId: string): LifeOpsDefinitionScope {
  return {
    agentId,
    domain: "user_lifeops",
    subjectType: "owner",
    subjectId: ownerId,
  };
}

function definitionInput(
  scope: LifeOpsDefinitionScope,
  title: string,
  dueAt = "2026-12-24T18:00:00.000Z",
) {
  return createLifeOpsTaskDefinition({
    ...scope,
    visibilityScope: "owner_only",
    contextPolicy: "explicit_only",
    kind: "reminder",
    title,
    description: `${title} description`,
    originalIntent: `Remind me about ${title}`,
    timezone: "America/Denver",
    status: "active",
    priority: 3,
    cadence: { kind: "once", dueAt },
    windowPolicy: {
      timezone: "America/Denver",
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
    source: "test",
    metadata: {},
  });
}

describe("definition mutation safety", () => {
  let runtimeResult: RealTestRuntimeResult | null = null;

  afterEach(async () => {
    await runtimeResult?.cleanup();
    runtimeResult = null;
  });

  it("isolates list/get/update/delete across two owners on one agent", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const scopeA = ownerScope(runtime.agentId, OWNER_A);
    const scopeB = ownerScope(runtime.agentId, OWNER_B);
    const alpha = await repository.createDefinition(
      definitionInput(scopeA, "Alpha reminder"),
    );
    const bravo = await repository.createDefinition(
      definitionInput(scopeB, "Bravo reminder"),
    );
    const serviceA = new LifeOpsService(runtime, { ownerEntityId: OWNER_A });
    const serviceB = new LifeOpsService(runtime, { ownerEntityId: OWNER_B });

    expect(
      (await serviceA.listDefinitions()).map((entry) => entry.definition.id),
    ).toEqual([alpha.id]);
    expect(
      (await serviceB.listDefinitions()).map((entry) => entry.definition.id),
    ).toEqual([bravo.id]);
    await expect(serviceA.getDefinition(bravo.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      serviceA.updateDefinition(bravo.id, { title: "Stolen title" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(serviceA.deleteDefinition(bravo.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(
      await repository.getDefinition(runtime.agentId, bravo.id, scopeB),
    ).toMatchObject({
      title: "Bravo reminder",
      revision: 1,
    });
    expect(
      await repository.getDefinition(runtime.agentId, bravo.id, scopeA),
    ).toBeNull();

    const retimed = await serviceA.updateDefinition(alpha.id, {
      timezone: "America/New_York",
    });
    expect(retimed.definition).toMatchObject({
      timezone: "America/New_York",
      windowPolicy: { timezone: "America/New_York" },
    });
    await expect(
      serviceA.createDefinition({
        kind: "reminder",
        title: "Mismatched timezone",
        timezone: "America/Denver",
        cadence: {
          kind: "once",
          dueAt: "2026-12-25T18:00:00.000Z",
        },
        windowPolicy: {
          timezone: "America/New_York",
          windows: [
            {
              name: "morning",
              label: "Morning",
              startMinute: 480,
              endMinute: 720,
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ status: 400 });

    await serviceB.deleteDefinition(bravo.id);
    expect(
      await repository.getDefinition(runtime.agentId, bravo.id, scopeB),
    ).toBeNull();
  });

  it("uses the owner-grounded row id when planner text points elsewhere", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const scopeA = ownerScope(runtime.agentId, OWNER_A);
    const scopeB = ownerScope(runtime.agentId, OWNER_B);
    const alpha = await repository.createDefinition(
      definitionInput(scopeA, "Alpha reminder"),
    );
    const charlie = await repository.createDefinition(
      definitionInput(scopeA, "Charlie reminder"),
    );
    const bravo = await repository.createDefinition(
      definitionInput(scopeB, "Bravo reminder"),
    );
    const message = {
      id: "00000000-0000-0000-0000-0000000000d4",
      agentId: runtime.agentId,
      entityId: OWNER_A,
      roomId: ROOM_ID,
      createdAt: Date.parse("2026-07-31T12:00:00.000Z"),
      content: {
        text: "Update Alpha reminder with the revised description.",
      },
    } as Memory;

    const options = {
      parameters: {
        subaction: "update",
        kind: "definition",
        target: "Charlie reminder",
        intent: "Update Alpha reminder with the revised description.",
        details: {
          description: "Revised by the owner-grounded selection.",
          cadence: alpha.cadence,
        },
      },
    } as HandlerOptions;
    const result = await runLifeOperationHandler(
      runtime,
      message,
      undefined,
      options,
    );

    expect(result.success).toBe(true);
    const afterFirst = await repository.getDefinition(
      runtime.agentId,
      alpha.id,
      scopeA,
    );
    expect(afterFirst).toMatchObject({
      description: "Revised by the owner-grounded selection.",
    });
    if (!afterFirst) {
      throw new Error("updated definition did not persist");
    }

    const replay = await runLifeOperationHandler(
      runtime,
      message,
      undefined,
      options,
    );

    expect(replay).toMatchObject({
      success: true,
      data: {
        deduplicated: true,
        mutationObservedAt: "2026-07-31T12:00:00.000Z",
      },
    });
    expect(
      await repository.getDefinition(runtime.agentId, alpha.id, scopeA),
    ).toMatchObject({
      description: "Revised by the owner-grounded selection.",
      revision: afterFirst.revision,
    });
    expect(
      await repository.getDefinition(runtime.agentId, charlie.id, scopeA),
    ).toMatchObject({
      description: "Charlie reminder description",
      revision: 1,
    });
    expect(
      await repository.getDefinition(runtime.agentId, bravo.id, scopeB),
    ).toMatchObject({
      description: "Bravo reminder description",
      revision: 1,
    });
  });

  it("rejects one of two concurrent writes from the same revision", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const scope = ownerScope(runtime.agentId, OWNER_A);
    const created = await repository.createDefinition(
      definitionInput(scope, "Concurrent reminder"),
    );
    const first = await repository.getDefinition(
      runtime.agentId,
      created.id,
      scope,
    );
    const second = await repository.getDefinition(
      runtime.agentId,
      created.id,
      scope,
    );
    if (!first || !second) {
      throw new Error("definition fixture did not persist");
    }

    const writes = await Promise.allSettled([
      repository.updateDefinition(
        { ...first, title: "First writer" },
        { scope, expectedRevision: first.revision },
      ),
      repository.updateDefinition(
        { ...second, title: "Second writer" },
        { scope, expectedRevision: second.revision },
      ),
    ]);

    expect(
      writes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejection = writes.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: expect.any(OptimisticLockError),
    });
    expect(
      await repository.getDefinition(runtime.agentId, created.id, scope),
    ).toMatchObject({ revision: 2 });
  });

  it("replays a completed mutation from a fresh repository instance", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const firstRepository = new LifeOpsRepository(runtime);
    const scope = ownerScope(runtime.agentId, OWNER_A);
    const definition = await firstRepository.createDefinition(
      definitionInput(scope, "Retry reminder"),
    );
    const firstClaim = await firstRepository.claimDefinitionMutation({
      scope,
      requestId: "message-retry-1",
      operation: "update_definition",
      definitionId: definition.id,
      expectedRevision: definition.revision,
      observedAt: "2026-07-31T12:34:56.000Z",
    });
    expect(firstClaim.disposition).toBe("claimed");
    if (firstClaim.disposition !== "claimed") {
      throw new Error("initial mutation claim was not acquired");
    }
    await firstRepository.completeDefinitionMutation({
      entry: firstClaim.entry,
      resultRevision: 2,
      result: { definitionId: definition.id, title: "Retry reminder" },
    });

    const restartedRepository = new LifeOpsRepository(runtime);
    const replay = await restartedRepository.claimDefinitionMutation({
      scope,
      requestId: "message-retry-1",
      operation: "update_definition",
      definitionId: definition.id,
      expectedRevision: 2,
    });

    expect(replay).toMatchObject({
      disposition: "completed",
      entry: {
        observedAt: "2026-07-31T12:34:56.000Z",
        resultRevision: 2,
        result: {
          definitionId: definition.id,
          title: "Retry reminder",
        },
      },
    });
  });
});
