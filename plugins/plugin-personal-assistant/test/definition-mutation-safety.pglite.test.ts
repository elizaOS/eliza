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

  it("heals a crash between a committed update and its ledger completion", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const scope = ownerScope(runtime.agentId, OWNER_A);
    const definition = await repository.createDefinition(
      definitionInput(scope, "Crashed update reminder"),
    );
    const message = {
      id: "00000000-0000-0000-0000-0000000000e5",
      agentId: runtime.agentId,
      entityId: OWNER_A,
      roomId: ROOM_ID,
      createdAt: Date.parse("2026-07-31T13:00:00.000Z"),
      content: { text: "Update Crashed update reminder." },
    } as Memory;
    const options = {
      parameters: {
        subaction: "update",
        kind: "definition",
        target: "Crashed update reminder",
        intent: "Update Crashed update reminder.",
        details: {
          description: "Post-crash description.",
          cadence: definition.cadence,
        },
      },
    } as HandlerOptions;

    // Executor claims the mutation, exactly as the action does for this
    // message id.
    const claim = await repository.claimDefinitionMutation({
      scope,
      requestId: message.id as string,
      operation: "update_definition",
      definitionId: definition.id,
      expectedRevision: definition.revision,
      observedAt: "2026-07-31T13:00:00.000Z",
    });
    expect(claim.disposition).toBe("claimed");

    // While the mutation has not committed, the outcome is not observable and
    // a retry must still answer "in progress" — reconciliation is
    // observation-based, never time-based.
    const whilePending = await runLifeOperationHandler(
      runtime,
      message,
      undefined,
      options,
    );
    expect(whilePending.success).toBe(false);
    expect(whilePending.text).toContain("already in progress");

    // The mutation commits (revision 1 -> 2)... and then the executor dies
    // before completeDefinitionMutation, leaving the ledger row pending.
    await repository.updateDefinition(
      { ...definition, description: "Post-crash description." },
      { scope, expectedRevision: definition.revision },
    );

    // A retry with the same message must now observe the committed outcome:
    // the reconciler resolves the stale pending row and the action answers
    // with the deduplicated success instead of "in progress" forever.
    const retry = await runLifeOperationHandler(
      runtime,
      message,
      undefined,
      options,
    );
    expect(retry).toMatchObject({
      success: true,
      data: { deduplicated: true },
    });
    const ledger = await repository.getDefinitionMutation({
      scope,
      requestId: message.id as string,
      operation: "update_definition",
    });
    expect(ledger).toMatchObject({
      status: "completed",
      resultRevision: 2,
      result: { definitionId: definition.id, reconciled: true },
    });
  });

  it("heals a crash between a committed delete and its ledger completion", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const scope = ownerScope(runtime.agentId, OWNER_A);
    const definition = await repository.createDefinition(
      definitionInput(scope, "Crashed delete reminder"),
    );
    const message = {
      id: "00000000-0000-0000-0000-0000000000f6",
      agentId: runtime.agentId,
      entityId: OWNER_A,
      roomId: ROOM_ID,
      createdAt: Date.parse("2026-07-31T14:00:00.000Z"),
      content: { text: "Delete Crashed delete reminder." },
    } as Memory;
    const options = {
      parameters: {
        subaction: "delete",
        kind: "definition",
        target: "Crashed delete reminder",
        intent: "Delete Crashed delete reminder.",
      },
    } as HandlerOptions;

    const claim = await repository.claimDefinitionMutation({
      scope,
      requestId: message.id as string,
      operation: "delete_definition",
      definitionId: definition.id,
      expectedRevision: definition.revision,
      observedAt: "2026-07-31T14:00:00.000Z",
    });
    expect(claim.disposition).toBe("claimed");

    // The delete commits through the domain (row delete + audit), then the
    // executor dies before completing the ledger row.
    const service = new LifeOpsService(runtime, { ownerEntityId: OWNER_A });
    await service.deleteDefinition(definition.id, {
      expectedRevision: definition.revision,
    });

    const retry = await runLifeOperationHandler(
      runtime,
      message,
      undefined,
      options,
    );
    expect(retry).toMatchObject({
      success: true,
      data: {
        deduplicated: true,
        deleted: { kind: "definition", id: definition.id },
      },
    });
    const ledger = await repository.getDefinitionMutation({
      scope,
      requestId: message.id as string,
      operation: "delete_definition",
    });
    expect(ledger).toMatchObject({
      status: "completed",
      result: { definitionId: definition.id, reconciled: true },
    });
  });

  it("rejects a stale selection instead of overwriting a concurrent mutation", async () => {
    runtimeResult = await createLifeOpsTestRuntime();
    const { runtime } = runtimeResult;
    await LifeOpsRepository.bootstrapSchema(runtime);
    const repository = new LifeOpsRepository(runtime);
    const scope = ownerScope(runtime.agentId, OWNER_A);
    const created = await repository.createDefinition(
      definitionInput(scope, "Contested reminder"),
    );
    const service = new LifeOpsService(runtime, { ownerEntityId: OWNER_A });

    // Both callers selected the definition at revision 1. The first mutation
    // lands and advances the revision.
    const first = await service.updateDefinition(
      created.id,
      { title: "First writer wins" },
      { expectedRevision: created.revision },
    );
    expect(first.definition.title).toBe("First writer wins");

    // The second caller's selection is now stale. The service must surface the
    // typed conflict, not silently re-read the latest revision and overwrite.
    await expect(
      service.updateDefinition(
        created.id,
        { description: "Second writer overwrite attempt" },
        { expectedRevision: created.revision },
      ),
    ).rejects.toBeInstanceOf(OptimisticLockError);

    // Same contract for delete — and because the guarded row delete runs
    // BEFORE the native provider delete, a stale conflict leaves the row (and
    // the native reminder) fully intact.
    await expect(
      service.deleteDefinition(created.id, {
        expectedRevision: created.revision,
      }),
    ).rejects.toBeInstanceOf(OptimisticLockError);
    expect(
      await repository.getDefinition(runtime.agentId, created.id, scope),
    ).toMatchObject({ title: "First writer wins" });
  });
});
