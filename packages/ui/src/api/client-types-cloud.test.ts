/**
 * Unit coverage for the pure ACP/task-thread → CodingAgentSession mappers.
 * Drives the real functions directly — no harness, no mocks.
 */
import { describe, expect, it } from "vitest";
import {
  type CodingAgentTaskThread,
  type CodingAgentTaskUsageSummary,
  mapAcpSessionsToCodingAgentSessions,
  mapTaskThreadsToCodingAgentSessions,
} from "./client-types-cloud";

const usage: CodingAgentTaskUsageSummary = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  state: "unavailable",
  byProvider: [],
};

function makeThread(
  overrides: Partial<CodingAgentTaskThread> = {},
): CodingAgentTaskThread {
  const base: CodingAgentTaskThread = {
    id: "t1",
    title: "Fix login flow",
    kind: "coding",
    status: "active",
    priority: "normal",
    paused: false,
    originalRequest: "fix the login flow",
    summary: "Working on it",
    sessionCount: 2,
    activeSessionCount: 1,
    latestSessionId: "s9",
    latestSessionLabel: "session nine",
    latestWorkdir: "/repo/a",
    latestRepo: "https://github.com/x/y",
    projectId: null,
    latestActivityAt: 1234,
    latestSessionModel: null,
    latestAccountProviderId: null,
    latestAccountId: null,
    latestAccountLabel: null,
    parentTaskId: null,
    decisionCount: 7,
    usage,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-02T00:00:00Z",
    closedAt: null,
    archivedAt: null,
  };
  return { ...base, ...overrides };
}

describe("mapAcpSessionsToCodingAgentSessions", () => {
  it("maps an empty list to an empty list", () => {
    expect(mapAcpSessionsToCodingAgentSessions([])).toEqual([]);
  });

  it("preserves input order across many sessions", () => {
    const result = mapAcpSessionsToCodingAgentSessions([
      { id: "a", name: "first" },
      { id: "b", name: "second" },
      { id: "c", name: "third" },
    ]);
    expect(result.map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
  });

  it("maps every field for a fully-populated ACP session", () => {
    const [session] = mapAcpSessionsToCodingAgentSessions([
      {
        id: "acp-1",
        name: "My Codex",
        agentType: "codex",
        workdir: "/repo/x",
        status: "busy",
        metadata: { label: "Pinned label" },
      },
    ]);
    expect(session).toEqual({
      sessionId: "acp-1",
      agentType: "codex",
      label: "Pinned label",
      originalTask: "",
      workdir: "/repo/x",
      status: "active",
      decisionCount: 0,
      autoResolvedCount: 0,
    });
  });

  it("defaults a missing agentType to claude", () => {
    const [session] = mapAcpSessionsToCodingAgentSessions([{ id: "x" }]);
    expect(session.agentType).toBe("claude");
  });

  it("resolves the label as metadata.label, then name, then agentType, then Agent", () => {
    const [labeled] = mapAcpSessionsToCodingAgentSessions([
      { id: "1", name: "named", agentType: "codex", metadata: { label: "L" } },
    ]);
    expect(labeled.label).toBe("L");

    const [named] = mapAcpSessionsToCodingAgentSessions([
      { id: "2", name: "named", agentType: "codex", metadata: {} },
    ]);
    expect(named.label).toBe("named");

    const [typed] = mapAcpSessionsToCodingAgentSessions([
      { id: "3", agentType: "codex" },
    ]);
    expect(typed.label).toBe("codex");

    const [fallback] = mapAcpSessionsToCodingAgentSessions([{ id: "4" }]);
    expect(fallback.label).toBe("Agent");
  });

  it("defaults a missing workdir to an empty string", () => {
    const [session] = mapAcpSessionsToCodingAgentSessions([{ id: "x" }]);
    expect(session.workdir).toBe("");
  });

  it("maps live statuses ready and busy to active", () => {
    const [ready, busy] = mapAcpSessionsToCodingAgentSessions([
      { id: "r", status: "ready" },
      { id: "b", status: "busy" },
    ]);
    expect(ready.status).toBe("active");
    expect(busy.status).toBe("active");
  });

  it("maps error to error", () => {
    const [session] = mapAcpSessionsToCodingAgentSessions([
      { id: "e", status: "error" },
    ]);
    expect(session.status).toBe("error");
  });

  it("maps stopped, done, completed, and exited to stopped", () => {
    const results = mapAcpSessionsToCodingAgentSessions([
      { id: "1", status: "stopped" },
      { id: "2", status: "done" },
      { id: "3", status: "completed" },
      { id: "4", status: "exited" },
    ]);
    expect(results.map((s) => s.status)).toEqual([
      "stopped",
      "stopped",
      "stopped",
      "stopped",
    ]);
  });

  it("treats unknown and missing statuses as active", () => {
    const results = mapAcpSessionsToCodingAgentSessions([
      { id: "u", status: "hibernating" },
      { id: "m" },
    ]);
    expect(results.map((s) => s.status)).toEqual(["active", "active"]);
  });

  it("always zeroes decision counters", () => {
    const [session] = mapAcpSessionsToCodingAgentSessions([
      { id: "z", status: "ready" },
    ]);
    expect(session.decisionCount).toBe(0);
    expect(session.autoResolvedCount).toBe(0);
  });
});

describe("mapTaskThreadsToCodingAgentSessions", () => {
  it("maps an empty list to an empty list", () => {
    expect(mapTaskThreadsToCodingAgentSessions([])).toEqual([]);
  });

  it("preserves input order across many threads", () => {
    const result = mapTaskThreadsToCodingAgentSessions([
      makeThread({ id: "a", latestSessionId: null }),
      makeThread({ id: "b", latestSessionId: null }),
      makeThread({ id: "c", latestSessionId: null }),
    ]);
    expect(result.map((s) => s.sessionId)).toEqual(["a", "b", "c"]);
  });

  it("maps the summary shape for a fully-populated thread", () => {
    const [session] = mapTaskThreadsToCodingAgentSessions([makeThread()]);
    expect(session).toEqual({
      sessionId: "s9",
      agentType: "task-thread",
      label: "Fix login flow",
      originalTask: "fix the login flow",
      workdir: "/repo/a",
      status: "active",
      decisionCount: 7,
      autoResolvedCount: 0,
      lastActivity: "Working on it",
    });
  });

  it("falls back sessionId from latestSessionId to the thread id", () => {
    const [latest] = mapTaskThreadsToCodingAgentSessions([makeThread()]);
    expect(latest.sessionId).toBe("s9");

    const [threadId] = mapTaskThreadsToCodingAgentSessions([
      makeThread({ latestSessionId: null }),
    ]);
    expect(threadId.sessionId).toBe("t1");
  });

  it("resolves the label as title, then latestSessionLabel, then Task", () => {
    const [titled] = mapTaskThreadsToCodingAgentSessions([
      makeThread({
        title: "Real title",
        latestSessionLabel: "session label",
      }),
    ]);
    expect(titled.label).toBe("Real title");

    const [fromLabel] = mapTaskThreadsToCodingAgentSessions([
      makeThread({ title: "", latestSessionLabel: "session label" }),
    ]);
    expect(fromLabel.label).toBe("session label");

    const [fallback] = mapTaskThreadsToCodingAgentSessions([
      makeThread({ title: "", latestSessionLabel: null }),
    ]);
    expect(fallback.label).toBe("Task");
  });

  it("falls back workdir from latestWorkdir to latestRepo to empty string", () => {
    const [workdir] = mapTaskThreadsToCodingAgentSessions([makeThread()]);
    expect(workdir.workdir).toBe("/repo/a");

    const [repo] = mapTaskThreadsToCodingAgentSessions([
      makeThread({ latestWorkdir: null }),
    ]);
    expect(repo.workdir).toBe("https://github.com/x/y");

    const [empty] = mapTaskThreadsToCodingAgentSessions([
      makeThread({ latestWorkdir: null, latestRepo: null }),
    ]);
    expect(empty.workdir).toBe("");
  });

  it("maps failed to error", () => {
    const [session] = mapTaskThreadsToCodingAgentSessions([
      makeThread({ status: "failed" }),
    ]);
    expect(session.status).toBe("error");
  });

  it("maps done to completed", () => {
    const [session] = mapTaskThreadsToCodingAgentSessions([
      makeThread({ status: "done" }),
    ]);
    expect(session.status).toBe("completed");
  });

  it("maps interrupted to stopped with the interruption activity line", () => {
    const [session] = mapTaskThreadsToCodingAgentSessions([
      makeThread({ status: "interrupted" }),
    ]);
    expect(session.status).toBe("stopped");
    expect(session.lastActivity).toBe(
      "Interrupted - reopen or resume this task",
    );
  });

  it("lets the interruption activity line win over a thread summary", () => {
    const [session] = mapTaskThreadsToCodingAgentSessions([
      makeThread({ status: "interrupted", summary: "Should be ignored" }),
    ]);
    expect(session.lastActivity).toBe(
      "Interrupted - reopen or resume this task",
    );
  });

  it("maps validating to tool_running", () => {
    const [session] = mapTaskThreadsToCodingAgentSessions([
      makeThread({ status: "validating" }),
    ]);
    expect(session.status).toBe("tool_running");
  });

  it("maps blocked and waiting_on_user to blocked", () => {
    const results = mapTaskThreadsToCodingAgentSessions([
      makeThread({ status: "blocked" }),
      makeThread({ status: "waiting_on_user" }),
    ]);
    expect(results.map((s) => s.status)).toEqual(["blocked", "blocked"]);
  });

  it("treats open, active, and archived as active", () => {
    const results = mapTaskThreadsToCodingAgentSessions([
      makeThread({ status: "open" }),
      makeThread({ status: "archived" }),
    ]);
    expect(results.map((s) => s.status)).toEqual(["active", "active"]);
  });

  it("resolves lastActivity as summary, then latestSessionLabel, then the raw status", () => {
    const [fromSummary] = mapTaskThreadsToCodingAgentSessions([
      makeThread({ status: "active", summary: "the summary" }),
    ]);
    expect(fromSummary.lastActivity).toBe("the summary");

    const [fromLabel] = mapTaskThreadsToCodingAgentSessions([
      makeThread({ status: "active", summary: undefined }),
    ]);
    expect(fromLabel.lastActivity).toBe("session nine");

    const [fromStatus] = mapTaskThreadsToCodingAgentSessions([
      makeThread({
        status: "active",
        summary: undefined,
        latestSessionLabel: null,
      }),
    ]);
    expect(fromStatus.lastActivity).toBe("active");
  });

  it("passes through decisionCount and zeroes autoResolvedCount", () => {
    const [session] = mapTaskThreadsToCodingAgentSessions([
      makeThread({ decisionCount: 42 }),
    ]);
    expect(session.decisionCount).toBe(42);
    expect(session.autoResolvedCount).toBe(0);
  });
});
