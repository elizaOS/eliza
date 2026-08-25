/**
 * Unit tests for validateScheduledTaskInput and ScheduledTaskValidationError.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  createCompletionCheckRegistry,
  registerBuiltInCompletionChecks,
} from "./completion-check-registry.js";
import { createEscalationLadderRegistry } from "./escalation.js";
import {
  createTaskGateRegistry,
  registerBuiltInGates,
} from "./gate-registry.js";
import type { ScheduledTaskInput } from "./types.js";
import {
  type ScheduledTaskValidationDeps,
  ScheduledTaskValidationError,
  validateScheduledTaskInput,
} from "./validation.js";

describe("validateScheduledTaskInput", () => {
  let deps: ScheduledTaskValidationDeps;

  beforeEach(() => {
    const gates = createTaskGateRegistry();
    registerBuiltInGates(gates);

    const completionChecks = createCompletionCheckRegistry();
    registerBuiltInCompletionChecks(completionChecks);

    const ladders = createEscalationLadderRegistry();

    deps = { gates, completionChecks, ladders };
  });

  const minimalValidTask: ScheduledTaskInput = {
    kind: "reminder",
    promptInstructions: "Drink water",
    priority: "medium",
    source: "user_chat",
    createdBy: "user-123",
    ownerVisible: true,
    respectsGlobalPause: true,
    trigger: {
      kind: "once",
      atIso: "2026-10-01T10:00:00.000Z",
    },
  };

  it("returns no issues for a minimal valid task", () => {
    const issues = validateScheduledTaskInput(minimalValidTask, deps);
    expect(issues).toEqual([]);
  });

  it("validates enums and non-empty strings on root fields", () => {
    const invalidTask = {
      ...minimalValidTask,
      kind: "invalid_kind" as never,
      promptInstructions: "   ",
      priority: "urgent" as never,
      source: "unknown" as never,
      createdBy: "",
      ownerVisible: "yes" as never,
      respectsGlobalPause: 1 as never,
    };

    const issues = validateScheduledTaskInput(invalidTask, deps);
    expect(issues).toContain("task.kind is invalid");
    expect(issues).toContain(
      "task.promptInstructions must be a non-empty string",
    );
    expect(issues).toContain("task.priority is invalid");
    expect(issues).toContain("task.source is invalid");
    expect(issues).toContain("task.createdBy must be a non-empty string");
    expect(issues).toContain("task.ownerVisible must be boolean");
    expect(issues).toContain("task.respectsGlobalPause must be boolean");
  });

  it("validates triggers: once, cron, interval, relative_to_anchor, and after_task", () => {
    expect(
      validateScheduledTaskInput(
        { ...minimalValidTask, trigger: { kind: "once", atIso: "not-a-date" } },
        deps,
      ),
    ).toContain("task.trigger.atIso must be an ISO timestamp");

    expect(
      validateScheduledTaskInput(
        {
          ...minimalValidTask,
          trigger: { kind: "cron", expression: "", tz: "UTC" },
        },
        deps,
      ),
    ).toContain("task.trigger.expression must be a non-empty string");

    expect(
      validateScheduledTaskInput(
        {
          ...minimalValidTask,
          trigger: { kind: "interval", everyMinutes: -5 },
        },
        deps,
      ),
    ).toContain("task.trigger.everyMinutes must be a positive integer");

    expect(
      validateScheduledTaskInput(
        {
          ...minimalValidTask,
          trigger: {
            kind: "relative_to_anchor",
            anchorKey: "",
            offsetMinutes: 10,
          },
        },
        deps,
      ),
    ).toContain("task.trigger.anchorKey must be a non-empty string");

    expect(
      validateScheduledTaskInput(
        {
          ...minimalValidTask,
          trigger: { kind: "after_task", taskId: "", outcome: "completed" },
        },
        deps,
      ),
    ).toContain(
      "task.trigger.after_task requires a non-empty taskId and terminal outcome",
    );
  });

  it("validates registered gates and parameters", () => {
    const taskWithGates: ScheduledTaskInput = {
      ...minimalValidTask,
      shouldFire: {
        compose: "all",
        gates: [
          { kind: "weekday_only", params: { weekdays: [1, 2, 3] } },
          { kind: "unregistered_gate" },
        ],
      },
    };

    const issues = validateScheduledTaskInput(taskWithGates, deps);
    expect(issues).toContain(
      'task.shouldFire.gates[1].kind "unregistered_gate" is not registered',
    );
  });

  it("validates registered completion checks", () => {
    const taskWithCheck: ScheduledTaskInput = {
      ...minimalValidTask,
      completionCheck: {
        kind: "unknown_check",
      },
    };

    const issues = validateScheduledTaskInput(taskWithCheck, deps);
    expect(issues).toContain(
      'task.completionCheck.kind "unknown_check" is not registered',
    );
  });

  it("detects cyclic pipeline task references", () => {
    const taskWithCycle: ScheduledTaskInput = {
      ...minimalValidTask,
    };
    taskWithCycle.pipeline = {
      onComplete: [taskWithCycle as never],
    };

    const issues = validateScheduledTaskInput(taskWithCycle, deps);
    expect(issues).toContain(
      "task.pipeline.onComplete[0] must not contain a cyclic task ref",
    );
  });

  it("ScheduledTaskValidationError formats issue message", () => {
    const err = new ScheduledTaskValidationError(
      ["issue 1", "issue 2"],
      "customTask",
    );
    expect(err.message).toBe("customTask: issue 1; issue 2");
    expect(err.code).toBe("scheduled_task_validation_failed");
    expect(err.name).toBe("ScheduledTaskValidationError");
  });
});
