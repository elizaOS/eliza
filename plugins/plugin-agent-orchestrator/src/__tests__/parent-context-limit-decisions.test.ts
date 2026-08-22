/**
 * Prompt-integrity coverage for the parent-context bridge (cap-audit
 * close-out):
 *  - `?limit=` on the memory search is a typed pre-dispatch rejection when
 *    malformed or out of range — never a silent Math.min clamp the child
 *    can't see,
 *  - an in-range limit is honored and echoed (caller-requested top-k),
 *  - the originating-task decisions block is a REPORTED recency projection:
 *    totalDecisions + a continuation naming the durable events route travel
 *    with the window.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import {
  handleParentContextRoutes,
  loadOriginatingTask,
} from "../api/parent-context-routes";
import type { RouteContext } from "../api/route-utils";

function makeReq(url: string): IncomingMessage {
  return {
    url,
    method: "GET",
    headers: { host: "localhost" },
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

function makeRes() {
  const chunks: string[] = [];
  let status = 0;
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (body?: string) => {
      if (body) chunks.push(body);
    },
  } as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    body: () =>
      JSON.parse(chunks.join("") || "null") as Record<string, unknown>,
  };
}

function memoryCtx(): RouteContext {
  return {
    runtime: {
      useModel: async () => [0.1, 0.2],
      searchMemories: async () => [],
    },
    acpService: {
      getSession: async () => ({
        id: "sess-1",
        status: "running",
        metadata: {},
      }),
    },
    workspaceService: null,
  } as unknown as RouteContext;
}

describe("bridge memory ?limit= contract", () => {
  it.each(["51", "0", "-2", "abc", "1e3", "2.5"])(
    "rejects out-of-range or malformed limit %s with a typed 400",
    async (limit) => {
      const { res, status, body } = makeRes();
      const handled = await handleParentContextRoutes(
        makeReq(`/api/coding-agents/sess-1/memory?q=hello&limit=${limit}`),
        res,
        "/api/coding-agents/sess-1/memory",
        memoryCtx(),
      );
      expect(handled).toBe(true);
      expect(status()).toBe(400);
      expect(body().code).toBe("invalid_limit");
      expect(String(body().error)).toContain("1 to 50");
    },
  );

  it("honors and echoes an in-range limit (caller-requested top-k)", async () => {
    const { res, status, body } = makeRes();
    await handleParentContextRoutes(
      makeReq("/api/coding-agents/sess-1/memory?q=hello&limit=50"),
      res,
      "/api/coding-agents/sess-1/memory",
      memoryCtx(),
    );
    expect(status()).toBe(200);
    expect(body()).toMatchObject({ query: "hello", limit: 50, hits: [] });
  });

  it("an absent limit uses the default without erroring", async () => {
    const { res, status, body } = makeRes();
    await handleParentContextRoutes(
      makeReq("/api/coding-agents/sess-1/memory?q=hello"),
      res,
      "/api/coding-agents/sess-1/memory",
      memoryCtx(),
    );
    expect(status()).toBe(200);
    expect(body().limit).toBe(10);
  });
});

describe("originating-task decisions projection", () => {
  function taskCtx(decisionCount: number): RouteContext {
    const decisions = Array.from({ length: decisionCount }, (_, i) => ({
      id: `d-${i + 1}`,
      sessionId: "sess-1",
      event: "spawn",
      decision: `decision ${i + 1}`,
      reasoning: "r",
      response: "ok",
      timestamp: i,
      createdAt: i,
    }));
    return {
      runtime: {
        getService: (name: string) =>
          name === "ORCHESTRATOR_TASK_SERVICE"
            ? {
                getTask: async () => ({
                  goal: "ship it",
                  acceptanceCriteria: ["done"],
                  decisions,
                }),
              }
            : null,
      },
      acpService: null,
      workspaceService: null,
    } as unknown as RouteContext;
  }

  it("windows to the latest 20 but REPORTS the total and continuation", async () => {
    const block = (await loadOriginatingTask(taskCtx(25), {
      taskId: "task-1",
    })) as Record<string, unknown>;
    const decisions = block.decisions as Array<{ id: string }>;
    expect(decisions).toHaveLength(20);
    // Recency window: the latest 20, oldest 5 elided — but named, not silent.
    expect(decisions[0]?.id).toBe("d-6");
    expect(decisions[19]?.id).toBe("d-25");
    expect(block.totalDecisions).toBe(25);
    expect(block.decisionsTruncated).toBe(true);
    expect(block.decisionsContinuation).toBe(
      "GET /api/orchestrator/tasks/task-1/events?cursor=&limit=",
    );
  });

  it("a short decision log passes through whole with no truncation fields", async () => {
    const block = (await loadOriginatingTask(taskCtx(5), {
      taskId: "task-1",
    })) as Record<string, unknown>;
    expect(block.decisions as unknown[]).toHaveLength(5);
    expect(block.totalDecisions).toBe(5);
    expect(block).not.toHaveProperty("decisionsTruncated");
    expect(block).not.toHaveProperty("decisionsContinuation");
  });
});
