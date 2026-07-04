/**
 * Verifies TASKS action aliases.
 * Deterministic unit test of pure helpers; no runtime, no live model.
 */
import { describe, expect, it } from "vitest";
import { tasksSandboxStubAction } from "../../src/actions/sandbox-stub.js";
import { tasksAction } from "../../src/actions/tasks.js";

describe("TASKS action aliases", () => {
  it("declares legacy coding-task aliases on the owning action", () => {
    expect(tasksAction.similes).toEqual(
      expect.arrayContaining(["CREATE_TASK", "START_CODING_TASK", "CODE_TASK"]),
    );
  });

  it("keeps the same aliases on the sandbox fallback action", () => {
    expect(tasksSandboxStubAction.similes).toEqual(
      expect.arrayContaining(["CREATE_TASK", "START_CODING_TASK", "CODE_TASK"]),
    );
  });
});
