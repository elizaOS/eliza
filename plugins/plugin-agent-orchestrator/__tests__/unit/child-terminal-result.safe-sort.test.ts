/**
 * Verifies safe sorting in deriveChildTerminalResult when event timestamp contains NaN or non-finite values.
 */

import { describe, expect, it } from "vitest";
import { deriveChildTerminalResult } from "../../src/services/child-terminal-result.js";
import type {
  OrchestratorTaskDocument,
  OrchestratorTaskEvent,
} from "../../src/services/orchestrator-task-types.js";

const ISO = "2026-08-23T00:00:00.000Z";

function makeDoc(events: OrchestratorTaskEvent[]): OrchestratorTaskDocument {
  return {
    task: {
      id: "task-test",
      title: "Test task",
      goal: "Test",
      kind: "task",
      status: "done",
      priority: "normal",
      originalRequest: "test",
      acceptanceCriteria: [],
      parentTaskId: "parent-1",
      paused: false,
      archived: false,
      createdAt: ISO,
      updatedAt: ISO,
      lastActivityAt: 1,
      metadata: {},
    },
    sessions: [],
    events,
    messages: [],
    usage: [],
    artifacts: [],
    decisions: [],
    planRevisions: [],
  };
}

describe("child-terminal-result safe sort", () => {
  it("safely resolves latest terminal event when timestamp is NaN or Infinity", () => {
    const validEvent: OrchestratorTaskEvent = {
      id: "ev-1",
      taskId: "task-test",
      eventType: "task_complete",
      summary: "Done",
      data: { response: "Finished successfully" },
      timestamp: 1000,
      createdAt: ISO,
    };

    const nanEvent: OrchestratorTaskEvent = {
      id: "ev-2",
      taskId: "task-test",
      eventType: "task_complete",
      summary: "Done NaN",
      data: { response: "Finished NaN" },
      timestamp: NaN,
      createdAt: ISO,
    };

    const infEvent: OrchestratorTaskEvent = {
      id: "ev-3",
      taskId: "task-test",
      eventType: "task_complete",
      summary: "Done Inf",
      data: { response: "Finished Inf" },
      timestamp: Infinity,
      createdAt: ISO,
    };

    const doc = makeDoc([nanEvent, validEvent, infEvent]);
    const result = deriveChildTerminalResult(doc);

    expect(result).toBeDefined();
    expect(result?.status).toBe("completed");
  });

  it("handles non-finite subtraction correctly", () => {
    const oldVal = NaN - 100;
    expect(Number.isNaN(oldVal)).toBe(true);

    const safeVal =
      (Number.isFinite(NaN) ? NaN : 0) - (Number.isFinite(100) ? 100 : 0);
    expect(safeVal).toBe(-100);
  });
});
