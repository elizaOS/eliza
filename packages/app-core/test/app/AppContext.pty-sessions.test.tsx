import {
  mapServerTasksToSessions,
  type ServerTask,
  TERMINAL_STATUSES,
} from "@elizaos/app-core/coding";
import { describe, expect, it } from "vitest";

/**
 * Tests for the PTY session hydration logic used in AppContext.
 *
 * mapServerTasksToSessions() filters out terminal statuses and maps
 * server tasks to CodingAgentSession objects. These tests exercise
 * the real production function imported from pty-session-hydrate.ts.
 */

describe("mapServerTasksToSessions — filtering", () => {
  it("filters out completed sessions", () => {
    const tasks: ServerTask[] = [
      { sessionId: "s-1", status: "active" },
      { sessionId: "s-2", status: "completed" },
    ];
    const result = mapServerTasksToSessions(tasks);
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe("s-1");
  });

  it("filters out stopped sessions", () => {
    const tasks: ServerTask[] = [
      { sessionId: "s-1", status: "active" },
      { sessionId: "s-2", status: "stopped" },
    ];
    const result = mapServerTasksToSessions(tasks);
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe("s-1");
  });

  it("filters out error sessions", () => {
    const tasks: ServerTask[] = [
      { sessionId: "s-1", status: "active" },
      { sessionId: "s-2", status: "error" },
    ];
    const result = mapServerTasksToSessions(tasks);
    expect(result.length).toBe(1);
    expect(result[0].sessionId).toBe("s-1");
  });

  it("filters out all terminal statuses from a mixed list", () => {
    const tasks: ServerTask[] = [
      { sessionId: "s-active", status: "active" },
      { sessionId: "s-completed", status: "completed" },
      { sessionId: "s-stopped", status: "stopped" },
      { sessionId: "s-error", status: "error" },
      { sessionId: "s-blocked", status: "blocked" },
      { sessionId: "s-tool", status: "tool_running" },
    ];
    const result = mapServerTasksToSessions(tasks);
    expect(result.length).toBe(3);
    expect(result.map((s) => s.sessionId)).toEqual([
      "s-active",
      "s-blocked",
      "s-tool",
    ]);
  });

  it("returns empty array when all sessions are terminal", () => {
    const tasks: ServerTask[] = [
      { sessionId: "s-1", status: "completed" },
      { sessionId: "s-2", status: "stopped" },
      { sessionId: "s-3", status: "error" },
    ];
    const result = mapServerTasksToSessions(tasks);
    expect(result.length).toBe(0);
  });

  it("returns empty array when tasks is empty", () => {
    const result = mapServerTasksToSessions([]);
    expect(result.length).toBe(0);
  });

  it("treats missing status as active (defaults)", () => {
    const tasks: ServerTask[] = [{ sessionId: "s-1" }];
    const result = mapServerTasksToSessions(tasks);
    expect(result.length).toBe(1);
    expect(result[0].status).toBe("active");
  });
});

describe("mapServerTasksToSessions — field mapping", () => {
  it("maps all fields with defaults", () => {
    const tasks: ServerTask[] = [{ sessionId: "s-1" }];
    const result = mapServerTasksToSessions(tasks);
    expect(result[0]).toEqual({
      sessionId: "s-1",
      agentType: "claude",
      label: "s-1",
      originalTask: "",
      workdir: "",
      status: "active",
      decisionCount: 0,
      autoResolvedCount: 0,
    });
  });

  it("maps all fields from server data", () => {
    const tasks: ServerTask[] = [
      {
        sessionId: "s-1",
        agentType: "gemini",
        label: "My Agent",
        originalTask: "Fix the bug",
        workdir: "/workspace/project",
        status: "blocked",
        decisionCount: 5,
        autoResolvedCount: 3,
      },
    ];
    const result = mapServerTasksToSessions(tasks);
    expect(result[0]).toEqual({
      sessionId: "s-1",
      agentType: "gemini",
      label: "My Agent",
      originalTask: "Fix the bug",
      workdir: "/workspace/project",
      status: "blocked",
      decisionCount: 5,
      autoResolvedCount: 3,
    });
  });
});

describe("TERMINAL_STATUSES constant", () => {
  it("contains exactly completed, stopped, error", () => {
    expect(TERMINAL_STATUSES).toEqual(
      new Set(["completed", "stopped", "error"]),
    );
  });

  it("does not contain active statuses", () => {
    expect(TERMINAL_STATUSES.has("active")).toBe(false);
    expect(TERMINAL_STATUSES.has("blocked")).toBe(false);
    expect(TERMINAL_STATUSES.has("tool_running")).toBe(false);
  });
});
