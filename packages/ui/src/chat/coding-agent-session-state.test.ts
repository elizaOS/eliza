/**
 * coding-agent-session-state contract — real module, no mocks: STATUS_DOT /
 * PULSE_STATUSES / TERMINAL_STATUSES membership, and every
 * mapServerTasksToSessions branch (terminal filtering, per-field ?? defaults,
 * order preservation, input immutability, empty input).
 */

import { describe, expect, it } from "vitest";
import type { ServerTask } from "./coding-agent-session-state";
import {
  mapServerTasksToSessions,
  PULSE_STATUSES,
  STATUS_DOT,
  TERMINAL_STATUSES,
} from "./coding-agent-session-state";

describe("STATUS_DOT", () => {
  it("maps each known status to its dot utility class", () => {
    expect(STATUS_DOT.active).toBe("bg-ok");
    expect(STATUS_DOT.tool_running).toBe("bg-accent");
    expect(STATUS_DOT.blocked).toBe("bg-warn");
    expect(STATUS_DOT.error).toBe("bg-danger");
  });

  it("yields undefined for an unknown status key", () => {
    expect(STATUS_DOT.nonexistent).toBeUndefined();
  });
});

describe("PULSE_STATUSES", () => {
  it("pulses only active and tool_running sessions", () => {
    expect(PULSE_STATUSES.size).toBe(2);
    expect(PULSE_STATUSES.has("active")).toBe(true);
    expect(PULSE_STATUSES.has("tool_running")).toBe(true);
  });

  it("does not pulse blocked, completed, stopped, error, or interrupted", () => {
    expect(PULSE_STATUSES.has("blocked")).toBe(false);
    expect(PULSE_STATUSES.has("completed")).toBe(false);
    expect(PULSE_STATUSES.has("stopped")).toBe(false);
    expect(PULSE_STATUSES.has("error")).toBe(false);
    expect(PULSE_STATUSES.has("interrupted")).toBe(false);
  });
});

describe("TERMINAL_STATUSES", () => {
  it("marks completed, stopped, error, and interrupted as terminal", () => {
    expect(TERMINAL_STATUSES.size).toBe(4);
    expect(TERMINAL_STATUSES.has("completed")).toBe(true);
    expect(TERMINAL_STATUSES.has("stopped")).toBe(true);
    expect(TERMINAL_STATUSES.has("error")).toBe(true);
    expect(TERMINAL_STATUSES.has("interrupted")).toBe(true);
  });

  it("does not treat live statuses as terminal", () => {
    expect(TERMINAL_STATUSES.has("active")).toBe(false);
    expect(TERMINAL_STATUSES.has("blocked")).toBe(false);
    expect(TERMINAL_STATUSES.has("tool_running")).toBe(false);
  });

  it("does not contain the nullish placeholder used by the filter", () => {
    expect(TERMINAL_STATUSES.has("")).toBe(false);
  });
});

describe("mapServerTasksToSessions", () => {
  it("returns an empty array for an empty queue", () => {
    expect(mapServerTasksToSessions([])).toEqual([]);
  });

  it("maps a fully populated task verbatim", () => {
    const tasks: ServerTask[] = [
      {
        sessionId: "sess-1",
        agentType: "codex",
        label: "Refactor auth",
        originalTask: "Refactor the auth module",
        workdir: "/repo/auth",
        status: "active",
        decisionCount: 7,
        autoResolvedCount: 3,
      },
    ];

    expect(mapServerTasksToSessions(tasks)).toEqual([
      {
        sessionId: "sess-1",
        agentType: "codex",
        label: "Refactor auth",
        originalTask: "Refactor the auth module",
        workdir: "/repo/auth",
        status: "active",
        decisionCount: 7,
        autoResolvedCount: 3,
      },
    ]);
  });

  it("applies defaults for every optional field when only sessionId is present", () => {
    const tasks: ServerTask[] = [{ sessionId: "sess-2" }];

    expect(mapServerTasksToSessions(tasks)).toEqual([
      {
        sessionId: "sess-2",
        agentType: "claude",
        label: "sess-2",
        originalTask: "",
        workdir: "",
        status: "active",
        decisionCount: 0,
        autoResolvedCount: 0,
      },
    ]);
  });

  it("drops tasks whose status is terminal", () => {
    expect(
      mapServerTasksToSessions(
        ["completed", "stopped", "error", "interrupted"].map((status) => ({
          sessionId: `done-${status}`,
          status,
        })),
      ),
    ).toEqual([]);
  });

  it("keeps tasks whose status is live", () => {
    expect(
      mapServerTasksToSessions(
        ["active", "blocked", "tool_running"].map((status) => ({
          sessionId: `live-${status}`,
          status,
        })),
      ).map((session) => session.sessionId),
    ).toEqual(["live-active", "live-blocked", "live-tool_running"]);
  });

  it("keeps a task with no status and defaults it to active", () => {
    const sessions = mapServerTasksToSessions([{ sessionId: "no-status" }]);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("no-status");
    expect(sessions[0]?.status).toBe("active");
  });

  it("filters by terminal-set membership, not by a known-status whitelist", () => {
    const sessions = mapServerTasksToSessions([
      { sessionId: "odd-live-a", status: "queued" },
      { sessionId: "odd-live-b", status: "crashed" },
    ]);

    expect(sessions.map((session) => session.sessionId)).toEqual([
      "odd-live-a",
      "odd-live-b",
    ]);
  });

  it("preserves input order across interleaved terminal and live tasks", () => {
    const sessions = mapServerTasksToSessions([
      { sessionId: "a", status: "active" },
      { sessionId: "b", status: "completed" },
      { sessionId: "c" },
      { sessionId: "d", status: "interrupted" },
      { sessionId: "e", status: "tool_running" },
    ]);

    expect(sessions.map((session) => session.sessionId)).toEqual([
      "a",
      "c",
      "e",
    ]);
  });

  it("resolves each task's label fallback independently", () => {
    const sessions = mapServerTasksToSessions([
      { sessionId: "x", label: "Named" },
      { sessionId: "y" },
    ]);

    expect(sessions.map((session) => session.label)).toEqual(["Named", "y"]);
  });

  it("does not mutate the input tasks", () => {
    const task: ServerTask = { sessionId: "sess-9" };

    mapServerTasksToSessions([task]);

    expect(task.agentType).toBeUndefined();
    expect(task.label).toBeUndefined();
    expect(task.originalTask).toBeUndefined();
    expect(task.workdir).toBeUndefined();
    expect(task.status).toBeUndefined();
    expect(task.decisionCount).toBeUndefined();
    expect(task.autoResolvedCount).toBeUndefined();
  });
});
