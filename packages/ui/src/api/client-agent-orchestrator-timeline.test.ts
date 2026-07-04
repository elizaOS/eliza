/**
 * Unit coverage for the orchestrator task-timeline client verb, including cursor
 * pagination. Transport stubbed, no live agent.
 */
import { describe, expect, it, vi } from "vitest";
import "./client-agent";
import { ElizaClient } from "./client-base";

describe("ElizaClient.listOrchestratorTaskTimeline", () => {
  it("fetches the normalized task timeline with cursor pagination", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn(async () => ({
      items: [
        {
          id: "message:message-1",
          kind: "message",
          threadId: "task-1",
          sessionId: null,
          timestamp: 1,
          createdAt: "2026-06-03T00:00:00.000Z",
          message: {
            id: "message-1",
            threadId: "task-1",
            sessionId: null,
            senderKind: "user",
            direction: "stdin",
            content: "continue",
            timestamp: 1,
            metadata: {},
            createdAt: "2026-06-03T00:00:00.000Z",
          },
        },
      ],
      nextCursor: "20",
    }));
    client.fetch = fetch as typeof client.fetch;

    const page = await client.listOrchestratorTaskTimeline("task/1", {
      cursor: "10",
      limit: 20,
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/orchestrator/tasks/task%2F1/timeline?cursor=10&limit=20",
    );
    expect(page.nextCursor).toBe("20");
    expect(page.items[0]?.kind).toBe("message");
  });
});

describe("ElizaClient orchestrator recovery controls", () => {
  it("posts retry, rerun, and restart recovery requests", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn(async () => ({
      id: "task-1",
      title: "Task",
      status: "active",
    }));
    client.fetch = fetch as typeof client.fetch;

    await client.retryOrchestratorTaskTurn("task/1", {
      sessionId: "session-1",
      instruction: "retry",
    });
    await client.rerunOrchestratorTaskFromEvent("task/1", {
      eventId: "event-1",
      instruction: "rerun",
      stopActive: true,
    });
    await client.restartOrchestratorTask("task/1", {
      instruction: "restart",
      stopActive: false,
    });
    await client.restartOrchestratorTaskWithEditedPlan("task/1", {
      plan: { summary: "edited plan" },
      editSummary: "restart with edit",
      stopActive: false,
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/orchestrator/tasks/task%2F1/retry-turn",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-1",
          instruction: "retry",
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/orchestrator/tasks/task%2F1/rerun-from-event",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          eventId: "event-1",
          instruction: "rerun",
          stopActive: true,
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "/api/orchestrator/tasks/task%2F1/restart",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          instruction: "restart",
          stopActive: false,
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      4,
      "/api/orchestrator/tasks/task%2F1/restart-with-edited-plan",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          plan: { summary: "edited plan" },
          editSummary: "restart with edit",
          stopActive: false,
        }),
      }),
    );
  });
});

describe("ElizaClient orchestrator plan revisions", () => {
  it("lists and creates plan revisions", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn(async (path: string) => {
      if (path.includes("?cursor=5&limit=10")) {
        return {
          items: [
            {
              id: "plan-1",
              threadId: "task-1",
              plan: { summary: "current" },
              basePlanRevisionId: null,
              editSummary: "operator edit",
              createdBy: "operator",
              metadata: {},
              timestamp: 1,
              createdAt: "2026-06-03T00:00:00.000Z",
            },
          ],
          nextCursor: null,
        };
      }
      return {
        id: "plan-2",
        threadId: "task-1",
        plan: { summary: "next" },
        basePlanRevisionId: "plan-1",
        editSummary: "next edit",
        createdBy: "operator",
        metadata: {},
        timestamp: 2,
        createdAt: "2026-06-03T00:00:01.000Z",
      };
    });
    client.fetch = fetch as typeof client.fetch;

    const page = await client.listOrchestratorTaskPlanRevisions("task/1", {
      cursor: "5",
      limit: 10,
    });
    const created = await client.createOrchestratorTaskPlanRevision("task/1", {
      plan: { summary: "next" },
      basePlanRevisionId: "plan-1",
      editSummary: "next edit",
    });

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/orchestrator/tasks/task%2F1/plan-revisions?cursor=5&limit=10",
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/orchestrator/tasks/task%2F1/plan-revisions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          plan: { summary: "next" },
          basePlanRevisionId: "plan-1",
          editSummary: "next edit",
        }),
      }),
    );
    expect(page.items[0]?.id).toBe("plan-1");
    expect(created?.id).toBe("plan-2");
  });
});
