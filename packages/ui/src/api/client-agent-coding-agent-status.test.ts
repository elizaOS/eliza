/**
 * Unit coverage for the coding-agent task-thread status client verbs. Transport
 * stubbed, no live agent.
 */
import { describe, expect, it, vi } from "vitest";
import "./client-agent";
import { ElizaClient } from "./client-base";
import type { CodingAgentTaskThread } from "./client-types";

function thread(overrides: Partial<CodingAgentTaskThread> = {}) {
  return {
    id: "task-1",
    title: "Durable task",
    kind: "coding",
    status: "active",
    priority: "normal",
    paused: false,
    originalRequest: "Build the thing",
    sessionCount: 1,
    activeSessionCount: 1,
    latestSessionId: "session-1",
    latestSessionLabel: "Worker",
    latestWorkdir: "/repo",
    latestRepo: null,
    latestActivityAt: Date.now(),
    decisionCount: 0,
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      state: "unavailable",
      byProvider: [],
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    archivedAt: null,
    ...overrides,
  } satisfies CodingAgentTaskThread;
}

describe("ElizaClient.getCodingAgentStatus", () => {
  it("includes durable task threads even when the legacy ACP endpoint fails", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    client.fetch = vi.fn(async (path: string) => {
      if (path === "/api/coding-agents") throw new Error("ACP unavailable");
      if (path === "/api/orchestrator/status") {
        return {
          taskCount: 3,
          activeTaskCount: 1,
          pausedTaskCount: 0,
          blockedTaskCount: 0,
          validatingTaskCount: 0,
          sessionCount: 1,
          activeSessionCount: 1,
          usage: {},
          byStatus: {},
        };
      }
      if (path === "/api/orchestrator/tasks?limit=20") {
        return { tasks: [thread()] };
      }
      throw new Error(`unexpected path: ${path}`);
    }) as typeof client.fetch;

    const status = await client.getCodingAgentStatus();

    expect(status).toMatchObject({
      supervisionLevel: "orchestrator",
      taskCount: 1,
      taskThreadCount: 3,
      taskThreads: [{ id: "task-1" }],
      tasks: [{ sessionId: "session-1", agentType: "task-thread" }],
    });
  });

  it("limits the durable task-thread preview used by status polling", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn(async (path: string) => {
      if (path === "/api/coding-agents") return [];
      if (path === "/api/orchestrator/status") return { taskCount: 0 };
      if (path === "/api/orchestrator/tasks?limit=20") return { tasks: [] };
      throw new Error(`unexpected path: ${path}`);
    });
    client.fetch = fetch as typeof client.fetch;

    await client.getCodingAgentStatus();

    expect(fetch).toHaveBeenCalledWith("/api/orchestrator/tasks?limit=20");
  });
});
