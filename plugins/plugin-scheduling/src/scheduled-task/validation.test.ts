/**
 * Pins the pipeline reference walk in validateScheduledTaskInput: task refs
 * shared across branches or fanned into from two children form a DAG and are
 * accepted, a genuine cycle is rejected, and the nesting cap still holds.
 * Deterministic, real registries, no runtime.
 */
import { describe, expect, it } from "vitest";
import { createCompletionCheckRegistry } from "./completion-check-registry.js";
import { createEscalationLadderRegistry } from "./escalation.js";
import { createTaskGateRegistry } from "./gate-registry.js";
import type {
  ScheduledTask,
  ScheduledTaskInput,
  ScheduledTaskRef,
} from "./types.js";
import { validateScheduledTaskInput } from "./validation.js";

const deps = {
  gates: createTaskGateRegistry(),
  completionChecks: createCompletionCheckRegistry(),
  ladders: createEscalationLadderRegistry(),
};

function input(
  overrides: Partial<ScheduledTaskInput> = {},
): ScheduledTaskInput {
  return {
    kind: "reminder",
    promptInstructions: "do the thing",
    trigger: { kind: "manual" },
    priority: "medium",
    respectsGlobalPause: true,
    source: "user_chat",
    createdBy: "tester",
    ownerVisible: true,
    ...overrides,
  };
}

let nextId = 0;
function taskRef(overrides: Partial<ScheduledTaskInput> = {}): ScheduledTask {
  nextId += 1;
  return {
    ...input(overrides),
    taskId: `task_${nextId}`,
    state: { status: "scheduled", followupCount: 0 },
  };
}

// The validator accepts a plain task input as a pipeline ref at runtime (it
// strips server-managed fields only when `taskId`/`state` are present), and
// in-process pipeline builders pass exactly that shape, so the DAG cases are
// pinned for both shapes.
function inputRef(
  overrides: Partial<ScheduledTaskInput> = {},
): ScheduledTaskRef {
  return input(overrides) as unknown as ScheduledTaskRef;
}

describe("validateScheduledTaskInput pipeline refs", () => {
  it("accepts one plain child input shared by two pipeline branches (#29938)", () => {
    const shared = inputRef({ promptInstructions: "shared follow-up" });
    const parent = input({
      pipeline: { onComplete: [shared], onSkip: [shared] },
    });
    expect(validateScheduledTaskInput(parent, deps)).toEqual([]);
  });

  it("accepts plain-input fan-in on one grandchild (#29938)", () => {
    const grandchild = inputRef({ promptInstructions: "fan-in target" });
    const left = inputRef({ pipeline: { onComplete: [grandchild] } });
    const right = inputRef({ pipeline: { onComplete: [grandchild] } });
    const parent = input({ pipeline: { onComplete: [left, right] } });
    expect(validateScheduledTaskInput(parent, deps)).toEqual([]);
  });

  it("rejects a plain child input that refers back to its parent", () => {
    const parent = input();
    const child = input({
      pipeline: { onComplete: [parent as unknown as ScheduledTaskRef] },
    });
    parent.pipeline = { onComplete: [child as unknown as ScheduledTaskRef] };
    expect(validateScheduledTaskInput(parent, deps)).toEqual([
      "task.pipeline.onComplete[0].pipeline.onComplete[0] must not contain a cyclic task ref",
    ]);
  });

  it("accepts one child ref shared by two pipeline branches", () => {
    const shared = taskRef({ promptInstructions: "shared follow-up" });
    const parent = input({
      pipeline: { onComplete: [shared], onSkip: [shared] },
    });
    expect(validateScheduledTaskInput(parent, deps)).toEqual([]);
  });

  it("accepts fan-in where two children reference the same grandchild", () => {
    const grandchild = taskRef({ promptInstructions: "fan-in target" });
    const left = taskRef({ pipeline: { onComplete: [grandchild] } });
    const right = taskRef({ pipeline: { onComplete: [grandchild] } });
    const parent = input({ pipeline: { onComplete: [left, right] } });
    expect(validateScheduledTaskInput(parent, deps)).toEqual([]);
  });

  it("accepts the same ref repeated inside one branch", () => {
    const child = taskRef();
    const parent = input({ pipeline: { onComplete: [child, child] } });
    expect(validateScheduledTaskInput(parent, deps)).toEqual([]);
  });

  it("rejects a two-task cycle", () => {
    const first = taskRef();
    const second = taskRef({ pipeline: { onComplete: [first] } });
    first.pipeline = { onComplete: [second] };
    const parent = input({ pipeline: { onComplete: [first] } });
    expect(validateScheduledTaskInput(parent, deps)).toEqual([
      "task.pipeline.onComplete[0].pipeline.onComplete[0].pipeline.onComplete[0] must not contain a cyclic task ref",
    ]);
  });

  it("rejects a ref that cycles back to itself", () => {
    const child = taskRef();
    child.pipeline = { onComplete: [child] };
    const parent = input({ pipeline: { onComplete: [child] } });
    expect(validateScheduledTaskInput(parent, deps)).toEqual([
      "task.pipeline.onComplete[0].pipeline.onComplete[0] must not contain a cyclic task ref",
    ]);
  });

  it("keeps the nesting cap", () => {
    let leaf = taskRef();
    for (let level = 0; level < 8; level += 1) {
      leaf = taskRef({ pipeline: { onComplete: [leaf] } });
    }
    const parent = input({ pipeline: { onComplete: [leaf] } });
    const issues = validateScheduledTaskInput(parent, deps);
    expect(
      issues.some((issue) => /nesting exceeds 8 levels$/.test(issue)),
    ).toBe(true);
  });
});
