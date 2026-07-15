/**
 * Pins the orchestrator's single legal-transition table (#13771). These are
 * pure-function assertions against {@link TASK_STATUS_TRANSITIONS} — the one
 * place that decides which `(from, trigger)` moves are legal — proving the
 * `failed` producer exists (`unrecoverable` edges), that terminal states are
 * immutable to session events, and that illegal transitions throw rather than
 * silently mis-set a status.
 */

import { describe, expect, it } from "vitest";
import {
  nextTaskStatus,
  type OrchestratorTaskStatus,
  resolveTaskTransition,
  TASK_STATUS_TRANSITIONS,
  type TaskLifecycleTrigger,
  TERMINAL_TASK_STATUSES,
} from "../../src/services/orchestrator-task-types.js";

const ALL_STATUSES: OrchestratorTaskStatus[] = [
  "open",
  "active",
  "waiting_on_user",
  "blocked",
  "validating",
  "done",
  "failed",
  "archived",
  "interrupted",
];

describe("TASK_STATUS_TRANSITIONS — legality", () => {
  it("every table target is a valid status", () => {
    for (const from of ALL_STATUSES) {
      for (const to of Object.values(TASK_STATUS_TRANSITIONS[from])) {
        expect(ALL_STATUSES).toContain(to);
      }
    }
  });

  it("`unrecoverable` is the sole producer of `failed`, reachable from every non-terminal state", () => {
    const producers: OrchestratorTaskStatus[] = [];
    for (const from of ALL_STATUSES) {
      for (const [trigger, to] of Object.entries(
        TASK_STATUS_TRANSITIONS[from],
      )) {
        if (to === "failed") {
          expect(trigger).toBe("unrecoverable");
          producers.push(from);
        }
      }
    }
    // Every non-terminal state can reach `failed` via `unrecoverable`.
    for (const from of ALL_STATUSES) {
      if (TERMINAL_TASK_STATUSES.has(from)) continue;
      expect(producers).toContain(from);
    }
  });

  it("terminal states are not mutated by any session-event trigger", () => {
    const sessionTriggers: TaskLifecycleTrigger[] = [
      "session_active",
      "session_blocked",
      "awaiting_user",
      "completion_reported",
      "validation_passed",
      "validation_failed",
      "retrying",
      "unrecoverable",
    ];
    for (const from of ALL_STATUSES) {
      if (!TERMINAL_TASK_STATUSES.has(from)) continue;
      for (const trigger of sessionTriggers) {
        expect(resolveTaskTransition(from, trigger)).toBeNull();
      }
    }
  });

  it("terminal states leave ONLY via operator triggers", () => {
    expect(resolveTaskTransition("done", "reopened")).toBe("open");
    expect(resolveTaskTransition("failed", "restarted")).toBe("active");
    expect(resolveTaskTransition("failed", "reopened")).toBe("open");
    expect(resolveTaskTransition("archived", "reopened")).toBe("open");
  });

  it("a weak `session_active` only promotes `open` (never stomps a stronger state)", () => {
    expect(resolveTaskTransition("open", "session_active")).toBe("active");
    expect(resolveTaskTransition("blocked", "session_active")).toBeNull();
    expect(
      resolveTaskTransition("waiting_on_user", "session_active"),
    ).toBeNull();
    expect(resolveTaskTransition("validating", "session_active")).toBeNull();
  });

  it("completion only reaches `done` through `validating`, never directly", () => {
    expect(resolveTaskTransition("active", "completion_reported")).toBe(
      "validating",
    );
    expect(resolveTaskTransition("validating", "validation_passed")).toBe(
      "done",
    );
    // No status jumps straight to `done` on a completion trigger.
    for (const from of ALL_STATUSES) {
      expect(TASK_STATUS_TRANSITIONS[from].completion_reported).not.toBe(
        "done",
      );
    }
  });

  it("automated validation verdicts are legal ONLY from `validating`", () => {
    for (const from of ALL_STATUSES) {
      const passed = resolveTaskTransition(from, "validation_passed");
      const failed = resolveTaskTransition(from, "validation_failed");
      if (from === "validating") {
        expect(passed).toBe("done");
        expect(failed).toBe("active");
      } else {
        expect(passed).toBeNull();
        expect(failed).toBeNull();
      }
    }
  });

  it("human overrides are legal from every non-terminal state and from no terminal one", () => {
    for (const from of ALL_STATUSES) {
      const passed = resolveTaskTransition(from, "human_override_passed");
      const failed = resolveTaskTransition(from, "human_override_failed");
      if (TERMINAL_TASK_STATUSES.has(from)) {
        expect(passed).toBeNull();
        expect(failed).toBeNull();
      } else {
        expect(passed).toBe("done");
        expect(failed).toBe("active");
      }
    }
  });

  it("`restarted` is total — the operator restart is legal from every state", () => {
    for (const from of ALL_STATUSES) {
      expect(resolveTaskTransition(from, "restarted")).toBe("active");
    }
  });

  it("nextTaskStatus throws on an illegal transition; resolveTaskTransition returns null", () => {
    expect(() => nextTaskStatus("done", "session_active")).toThrow(
      /Illegal task transition/,
    );
    expect(() => nextTaskStatus("validating", "session_active")).toThrow(
      /Illegal task transition/,
    );
    expect(resolveTaskTransition("done", "session_active")).toBeNull();
    // A legal edge does not throw.
    expect(nextTaskStatus("open", "session_active")).toBe("active");
  });
});
