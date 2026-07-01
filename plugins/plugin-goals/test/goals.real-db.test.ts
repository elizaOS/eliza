/**
 * Real-DB integration tests for the goals back-end.
 *
 * Unlike `goals-service.test.ts` (which fakes `runtime.adapter.db.execute`),
 * this suite boots a REAL PGLite-backed AgentRuntime via
 * {@link createRealTestRuntime} and materializes the goal tables the way the
 * runtime does in production: the goal CRUD reads/writes the carved
 * `app_goals.life_goal_*` tables, so we register a schema-only goals plugin
 * (`goalsDbSchema`) and let the SQL plugin's migration runner create them. The
 * goals back-end also cross-writes PA's `app_lifeops.life_audit_events` /
 * `life_task_definitions`, so we additionally call
 * `LifeOpsRepository.bootstrapSchema` to create the `app_lifeops` schema.
 *
 * The PA import is a TEST-ONLY relative import for the app_lifeops bootstrap;
 * the goals SOURCE carries no dependency on `@elizaos/plugin-personal-assistant`.
 *
 * Every assertion is an insert-then-read-back round-trip against the live DB.
 * Hermetic: no network, no credentials, no LLM (GoalsService CRUD is rule-based).
 */

import type { AgentRuntime, Plugin } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createRealTestRuntime,
  type RealTestRuntimeResult,
} from "../../../packages/test/helpers/real-runtime.ts";
// Test-only: PA owns the app_lifeops audit/task tables + their schema bootstrap.
// The goals plugin SOURCE never imports PA (verified by the boundary contract).
import { LifeOpsRepository } from "../../plugin-personal-assistant/src/lifeops/repository.ts";
import { GoalsRepository } from "../src/db/goals-repository.ts";
import { goalsDbSchema } from "../src/db/schema.ts";
import { executeRawSql } from "../src/db/sql.ts";
import { createOwnerGoalsService } from "../src/goals-runtime.ts";
import type { GoalsService } from "../src/goals-service.ts";

/**
 * Schema-only test plugin so `runtime.initialize()` runs the SQL plugin
 * migration that creates the carved `app_goals.life_goal_*` tables (we register
 * just the schema, not the full goals plugin's services/actions/views).
 */
const goalsSchemaPlugin: Plugin = {
  name: "goals-real-db-schema",
  description: "Test-only goals table bootstrap.",
  schema: goalsDbSchema,
};

describe("GoalsService + GoalsRepository — real PGLite", () => {
  let runtime: AgentRuntime;
  let testResult: RealTestRuntimeResult;
  let service: GoalsService;
  let repository: GoalsRepository;

  beforeAll(async () => {
    testResult = await createRealTestRuntime({
      characterName: "goals-real-db-tests",
      plugins: [goalsSchemaPlugin],
    });
    runtime = testResult.runtime;
    // The goals schema plugin creates app_goals.life_goal_* via the SQL
    // migration runner; bootstrapSchema creates app_lifeops (audit + task) for
    // the goals back-end's cross-schema audit/FK-nullout writes.
    await LifeOpsRepository.bootstrapSchema(runtime);
    service = createOwnerGoalsService(runtime);
    repository = new GoalsRepository(runtime);
  }, 180_000);

  afterAll(async () => {
    await testResult?.cleanup();
  });

  it("creates a goal and reads it back via get / list / repository", async () => {
    const created = await service.createGoal({
      title: "Run a marathon this year",
      description: "Train for and finish a marathon",
      successCriteria: { distanceKm: 42 },
    });
    expect(created.goal.id).toBeTruthy();
    expect(created.goal.title).toBe("Run a marathon this year");
    expect(created.goal.status).toBe("active");
    expect(created.goal.subjectType).toBe("owner");
    expect(created.goal.domain).toBe("user_lifeops");

    // Round-trip via the service.
    const got = await service.getGoal(created.goal.id);
    expect(got.goal.title).toBe("Run a marathon this year");
    expect(got.goal.successCriteria).toEqual({ distanceKm: 42 });

    // Round-trip via the repository (raw row → parsed domain object).
    const repoGoal = await repository.getGoal(runtime.agentId, created.goal.id);
    expect(repoGoal).not.toBeNull();
    expect(repoGoal?.description).toBe("Train for and finish a marathon");

    const all = await service.listGoals();
    expect(all.map((r) => r.goal.title)).toContain("Run a marathon this year");
  });

  it("records a goal_created audit event into the real audit table", async () => {
    const created = await service.createGoal({ title: "Read 12 books" });
    const rows = await executeRawSql(
      runtime,
      `SELECT * FROM app_lifeops.life_audit_events WHERE owner_id = '${created.goal.id}'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.event_type === "goal_created")).toBe(true);
  });

  it("updates a goal and persists the change", async () => {
    const created = await service.createGoal({ title: "Learn to paint" });
    const updated = await service.updateGoal(created.goal.id, {
      title: "Learn watercolor painting",
      status: "paused",
    });
    expect(updated.goal.title).toBe("Learn watercolor painting");
    expect(updated.goal.status).toBe("paused");

    // Re-read straight from the DB to prove the UPDATE landed.
    const reread = await repository.getGoal(runtime.agentId, created.goal.id);
    expect(reread?.title).toBe("Learn watercolor painting");
    expect(reread?.status).toBe("paused");
  });

  it("short-circuits a near-duplicate active goal via dedup (real DB read)", async () => {
    const first = await service.createGoal({
      title: "Meditate every morning",
      description: "build a daily meditation habit",
    });
    const before = (await service.listGoals()).length;
    const dup = await service.createGoal({
      title: "Meditate every morning",
      description: "daily meditation habit",
    });
    expect(dup.goal.id).toBe(first.goal.id);
    // No new row was written.
    const after = (await service.listGoals()).length;
    expect(after).toBe(before);
  });

  it("creates + lists goal links, then deletes the goal and its links", async () => {
    const created = await service.createGoal({ title: "Ship the app" });
    await repository.upsertGoalLink({
      id: "link-1",
      agentId: runtime.agentId,
      goalId: created.goal.id,
      linkedType: "task",
      linkedId: "task-abc",
      createdAt: new Date().toISOString(),
    });
    // ON CONFLICT DO NOTHING: re-upserting the same link is a no-op.
    await repository.upsertGoalLink({
      id: "link-1-dup",
      agentId: runtime.agentId,
      goalId: created.goal.id,
      linkedType: "task",
      linkedId: "task-abc",
      createdAt: new Date().toISOString(),
    });
    const links = await repository.listGoalLinksForGoal(
      runtime.agentId,
      created.goal.id,
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.linkedId).toBe("task-abc");

    const recordWithLink = await service.getGoal(created.goal.id);
    expect(recordWithLink.links).toHaveLength(1);

    await service.deleteGoal(created.goal.id);
    expect(
      await repository.getGoal(runtime.agentId, created.goal.id),
    ).toBeNull();
    expect(
      await repository.listGoalLinksForGoal(runtime.agentId, created.goal.id),
    ).toHaveLength(0);
  });
});
