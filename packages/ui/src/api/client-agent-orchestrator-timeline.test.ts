/**
 * Unit coverage for the orchestrator task-timeline client verb, including cursor
 * pagination. Transport stubbed, no live agent.
 */
import { describe, expect, it, vi } from "vitest";
import "./client-agent";
import "./client-orchestrator-widgets";
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

describe("ElizaClient.getOrchestratorWidgets", () => {
  it("fetches the bounded widget snapshot with encoded project options", async () => {
    const client = new ElizaClient("http://agent.example:31337", "token");
    const fetch = vi.fn(async () => ({
      version: "orchestrator.widgets.v1",
      generatedAt: "2026-07-13T00:00:00.000Z",
      totalTaskCount: 0,
      tasks: [],
    }));
    client.fetch = fetch as typeof client.fetch;

    const snapshot = await client.getOrchestratorWidgets({
      includeArchived: true,
      projectId: "project / alpha",
      limit: 8,
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/orchestrator/widgets?includeArchived=true&projectId=project+%2F+alpha&limit=8",
    );
    expect(snapshot.totalTaskCount).toBe(0);
  });

  it("delivers named SSE snapshots and closes the browser subscription", () => {
    class FakeEventSource extends EventTarget {
      static latest: FakeEventSource | undefined;
      readonly url: string;
      close = vi.fn();

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        FakeEventSource.latest = this;
      }
    }
    const previous = globalThis.EventSource;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
    try {
      const client = new ElizaClient("http://agent.example:31337", "token");
      const onSnapshot = vi.fn();
      const onError = vi.fn();
      const close = client.streamOrchestratorWidgets(
        { limit: 8 },
        onSnapshot,
        onError,
      );
      const source = FakeEventSource.latest;
      if (!source) throw new Error("EventSource was not opened");

      const event = new Event("snapshot");
      Object.defineProperty(event, "data", {
        value: JSON.stringify({
          version: "orchestrator.widgets.v1",
          generatedAt: "2026-07-13T00:00:00.000Z",
          totalTaskCount: 0,
          tasks: [],
        }),
      });
      source.dispatchEvent(event);

      expect(source.url).toBe(
        "http://agent.example:31337/api/orchestrator/widgets/stream?limit=8",
      );
      expect(onSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ totalTaskCount: 0, tasks: [] }),
      );
      expect(onError).not.toHaveBeenCalled();

      const malformedSnapshot = new Event("snapshot");
      Object.defineProperty(malformedSnapshot, "data", { value: "{" });
      source.dispatchEvent(malformedSnapshot);
      expect(onError).toHaveBeenLastCalledWith(expect.any(SyntaxError));

      const serverError = new Event("error");
      Object.defineProperty(serverError, "data", {
        value: JSON.stringify({ error: "task store unavailable" }),
      });
      source.dispatchEvent(serverError);
      expect(onError).toHaveBeenLastCalledWith(
        expect.objectContaining({ message: "task store unavailable" }),
      );

      const malformedError = new Event("error");
      Object.defineProperty(malformedError, "data", { value: "{" });
      source.dispatchEvent(malformedError);
      expect(onError).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: "Orchestrator task stream returned invalid error data",
        }),
      );

      source.dispatchEvent(new Event("error"));
      expect(onError).toHaveBeenLastCalledWith(
        expect.objectContaining({
          message: "Orchestrator task stream disconnected",
        }),
      );

      close();
      expect(source.close).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.EventSource = previous;
    }
  });

  it("returns a harmless closer when EventSource is unavailable", () => {
    const previous = globalThis.EventSource;
    Reflect.deleteProperty(globalThis, "EventSource");
    try {
      const client = new ElizaClient("http://agent.example:31337", "token");
      const close = client.streamOrchestratorWidgets(
        undefined,
        vi.fn(),
        vi.fn(),
      );
      expect(close()).toBeUndefined();
    } finally {
      globalThis.EventSource = previous;
    }
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
