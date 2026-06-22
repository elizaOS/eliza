/**
 * {@link OrchestratorTaskService.createTask} default-criteria wiring (#8896).
 *
 * A task created from a plain request ("fix this bug") used to carry NO
 * acceptance criteria, so the auto goal-verifier fast-pathed to pass / parked
 * forever in `validating`. createTask now populates measurable defaults when:
 *   - the caller supplied none, AND
 *   - the goal is non-trivial, AND
 *   - the `ELIZA_REQUIRE_GOAL_CONTRACT` flag is on (default).
 *
 * Caller-supplied criteria are always preserved unchanged.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { OrchestratorTaskStore } from "../../src/services/orchestrator-task-store.js";

/** A minimal runtime with NO `useModel`, forcing the deterministic static
 *  fallback path (no model spend, fully reproducible). */
function staticRuntime(): IAgentRuntime {
  return {
    getService: () => null,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  } as unknown as IAgentRuntime;
}

function makeService(): OrchestratorTaskService {
  const store = new OrchestratorTaskStore({ backend: "memory" });
  return new OrchestratorTaskService(staticRuntime(), { store });
}

const FLAG = "ELIZA_REQUIRE_GOAL_CONTRACT";
let prevFlag: string | undefined;

beforeEach(() => {
  prevFlag = process.env[FLAG];
  delete process.env[FLAG];
});

afterEach(() => {
  if (prevFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = prevFlag;
});

describe("createTask default acceptance criteria", () => {
  it("populates ≥3 criteria for a criteria-free, non-trivial coding task", async () => {
    const service = makeService();
    const task = await service.createTask({
      title: "Fix bug",
      goal: "fix the off-by-one error in the date parser",
    });
    expect(task.acceptanceCriteria.length).toBeGreaterThanOrEqual(3);
    // Static coding template — deterministic without a model.
    expect(task.acceptanceCriteria).toContain("typecheck passes");
    expect(task.acceptanceCriteria).toContain("tests pass");
  });

  it("derives a view-create criteria set from the goal text", async () => {
    const service = makeService();
    const task = await service.createTask({
      title: "Add view",
      goal: "create a new dashboard view with a viewKind for usage",
    });
    expect(task.acceptanceCriteria.some((c) => c.includes("/api/views"))).toBe(
      true,
    );
    expect(task.acceptanceCriteria).not.toContain("typecheck passes");
  });

  it("uses an explicit kind as the task-type hint over goal keywords", async () => {
    const service = makeService();
    const task = await service.createTask({
      title: "Deploy",
      // Goal reads like coding, but kind forces the deploy template.
      goal: "make the service reachable from the internet",
      kind: "deploy",
    });
    expect(
      task.acceptanceCriteria.some((c) => c.toLowerCase().includes("rollback")),
    ).toBe(true);
  });

  it("never overwrites caller-supplied criteria", async () => {
    const service = makeService();
    const supplied = ["only this one matters"];
    const task = await service.createTask({
      title: "Custom",
      goal: "do the custom thing with measurable proof",
      acceptanceCriteria: supplied,
    });
    expect(task.acceptanceCriteria).toEqual(supplied);
  });

  it("leaves criteria empty when the flag is off", async () => {
    process.env[FLAG] = "0";
    const service = makeService();
    const task = await service.createTask({
      title: "Fix bug",
      goal: "fix the off-by-one error in the date parser",
    });
    expect(task.acceptanceCriteria).toEqual([]);
  });

  it("leaves criteria empty for a trivial goal even with the flag on", async () => {
    const service = makeService();
    const task = await service.createTask({ title: "x", goal: "fix" });
    expect(task.acceptanceCriteria).toEqual([]);
  });
});
