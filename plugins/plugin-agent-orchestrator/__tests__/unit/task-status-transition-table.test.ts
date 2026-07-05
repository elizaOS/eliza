/**
 * Pins the durable-task legal-transition table (orchestrator-task-types): the
 * single source of truth the ACP→task status writer consults. Pure, no runtime.
 * Guards the invariants that used to live as scattered inline checks —
 * terminal-no-exit, active-only-from-open, and (the #13771 fix) a reachable
 * `failed` terminal so a crashed sub-agent can never wedge a task non-terminal.
 */
import { describe, expect, it } from "vitest";
import {
  isLegalTaskTransition,
  LEGAL_TASK_TRANSITIONS,
  type OrchestratorTaskStatus,
  TERMINAL_TASK_STATUSES,
} from "../../src/services/orchestrator-task-types.js";

const ALL_STATUSES = Object.keys(
  LEGAL_TASK_TRANSITIONS,
) as OrchestratorTaskStatus[];

describe("legal task-status transition table", () => {
  it("declares an entry for every status (no missing rows)", () => {
    const expected: OrchestratorTaskStatus[] = [
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
    expect(new Set(ALL_STATUSES)).toEqual(new Set(expected));
  });

  it("gives the unrecoverable-error producer a home: `failed` is reachable from every non-terminal state", () => {
    for (const from of ALL_STATUSES) {
      if (TERMINAL_TASK_STATUSES.has(from)) continue;
      expect(isLegalTaskTransition(from, "failed")).toBe(true);
    }
  });

  it("rejects all outgoing transitions from terminal states (once terminal, always terminal)", () => {
    for (const terminal of TERMINAL_TASK_STATUSES) {
      for (const to of ALL_STATUSES) {
        expect(isLegalTaskTransition(terminal, to)).toBe(false);
      }
    }
  });

  it("permits `active` only from `open` (a late ready/reconnect can't stomp blocked/validating)", () => {
    expect(isLegalTaskTransition("open", "active")).toBe(true);
    for (const from of ALL_STATUSES) {
      if (from === "open") continue;
      expect(isLegalTaskTransition(from, "active")).toBe(false);
    }
  });

  it("permits the transitions the event bridge actually drives", () => {
    // ready/reconnected → active (from open)
    expect(isLegalTaskTransition("open", "active")).toBe(true);
    // blocked event → blocked
    expect(isLegalTaskTransition("active", "blocked")).toBe(true);
    // login_required → waiting_on_user
    expect(isLegalTaskTransition("active", "waiting_on_user")).toBe(true);
    // task_complete → validating
    expect(isLegalTaskTransition("active", "validating")).toBe(true);
    // validating → done (validation success)
    expect(isLegalTaskTransition("validating", "done")).toBe(true);
    // unrecoverable error mid-validation → failed
    expect(isLegalTaskTransition("validating", "failed")).toBe(true);
  });

  it("treats a self-transition as a non-edge (callers no-op it; not enumerated as legal)", () => {
    for (const status of ALL_STATUSES) {
      expect(isLegalTaskTransition(status, status)).toBe(false);
    }
  });
});
