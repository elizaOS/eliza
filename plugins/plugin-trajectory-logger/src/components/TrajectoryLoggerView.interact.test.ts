/**
 * Tests the view-bundle `interact` capability handler against a stubbed `fetch`,
 * asserting each TUI capability (list-trajectories, open-latest, filter-phase,
 * refresh) issues the right trajectory route request.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { interact } from "./TrajectoryLoggerView.interact.js";

interface RecordedCall {
  url: string;
  method: string;
}

/**
 * Stub fetch to serve a real-shaped list envelope + per-id detail payloads.
 * The detail shape mirrors @elizaos/plugin-training's GET /api/trajectories/:id
 * (UITrajectoryDetailResult): trajectory + llmCalls (with stepType/purpose/
 * actionType/response) + toolEvents + evaluationEvents.
 */
function installFetch(): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const listEnvelope = {
    trajectories: [
      { id: "t1", status: "active", llmCallCount: 2 },
      { id: "t2", status: "completed", llmCallCount: 1 },
      { id: "t3", status: "completed", llmCallCount: 1 },
    ],
    total: 3,
    offset: 0,
    limit: 10,
  };
  const detailFor = (id: string) => ({
    trajectory: { id, status: id === "t1" ? "active" : "completed" },
    llmCalls: [
      {
        id: `${id}-c1`,
        model: "m",
        response: '{"action":"RESPOND"}',
        // filter-phase matches the literal phase NAME as a substring of
        // purpose/stepType/actionType (uppercased). "handle_message" contains
        // "HANDLE", so this call matches a phase=HANDLE filter.
        purpose: "handle_message",
        actionType: "",
        stepType: "should_respond",
      },
      {
        id: `${id}-c2`,
        model: "m",
        response: "hi",
        purpose: "",
        actionType: "REPLY",
        stepType: "response",
      },
    ],
    providerAccesses: [{ id: `${id}-p1`, providerName: "TIME", purpose: "" }],
    toolEvents: [{ id: `${id}-te1`, type: "tool_result", actionName: "REPLY" }],
    evaluationEvents: [
      { id: `${id}-ee1`, type: "evaluator", evaluatorName: "REFLECTION" },
    ],
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.startsWith("/api/trajectories?")) {
        const limit = Number(
          new URL(url, "http://x").searchParams.get("limit"),
        );
        return {
          ok: true,
          json: async () => ({
            ...listEnvelope,
            trajectories: listEnvelope.trajectories.slice(
              0,
              Number.isFinite(limit) ? limit : 10,
            ),
            limit,
          }),
        } as unknown as Response;
      }
      const id = decodeURIComponent(url.split("/api/trajectories/")[1] ?? "");
      return {
        ok: true,
        json: async () => detailFor(id),
      } as unknown as Response;
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("interact list-trajectories / refresh", () => {
  it("list-trajectories returns the list and honors a passed limit", async () => {
    const calls = installFetch();
    const result = (await interact("list-trajectories", { limit: 2 })) as {
      trajectories: unknown[];
      total: number;
    };
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/trajectories?limit=2");
    expect(calls[0].method).toBe("GET");
    expect(result.trajectories).toHaveLength(2);
    expect(result.total).toBe(3);
  });

  it("list-trajectories defaults to limit 10 when none is passed", async () => {
    const calls = installFetch();
    await interact("list-trajectories");
    expect(calls[0].url).toBe("/api/trajectories?limit=10");
  });

  it("refresh behaves identically to list-trajectories (default limit 10)", async () => {
    const calls = installFetch();
    const result = (await interact("refresh")) as { trajectories: unknown[] };
    expect(calls[0].url).toBe("/api/trajectories?limit=10");
    expect(result.trajectories.length).toBeGreaterThan(0);
  });
});

describe("interact open-latest", () => {
  it("fetches the list with limit 1 then the detail of the latest", async () => {
    const calls = installFetch();
    const detail = (await interact("open-latest")) as {
      trajectory: { id: string };
    };
    expect(calls[0].url).toBe("/api/trajectories?limit=1");
    expect(calls[1].url).toBe("/api/trajectories/t1");
    expect(detail.trajectory.id).toBe("t1");
  });

  it("returns null when the list is empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ trajectories: [], total: 0, offset: 0, limit: 1 }),
      })) as unknown as typeof fetch,
    );
    const result = await interact("open-latest");
    expect(result).toBeNull();
  });
});

describe("interact filter-phase", () => {
  it("defaults to HANDLE, slices the first 5, and returns per-trajectory phase counts", async () => {
    const calls = installFetch();
    const result = (await interact("filter-phase")) as Array<{
      id: string;
      status: string;
      phase: string;
      llmCalls: number;
      toolEvents: number;
      evaluationEvents: number;
    }>;

    // List fetch (limit 10) + one detail fetch per trajectory (3 here).
    expect(calls[0].url).toBe("/api/trajectories?limit=10");
    expect(
      calls.filter((c) => c.url.startsWith("/api/trajectories/")),
    ).toHaveLength(3);

    expect(result).toHaveLength(3);
    const first = result[0];
    expect(first.id).toBe("t1");
    expect(first.phase).toBe("HANDLE");
    // c1.purpose "handle_message" contains "HANDLE" -> 1 matching llm call.
    expect(first.llmCalls).toBe(1);
    expect(first.toolEvents).toBe(1);
    expect(first.evaluationEvents).toBe(1);
  });

  it("uppercases the requested phase and matches it against actionType", async () => {
    installFetch();
    const result = (await interact("filter-phase", {
      phase: "reply",
    })) as Array<{
      phase: string;
      llmCalls: number;
    }>;
    // lowercase "reply" is uppercased to "REPLY"; c2.actionType "REPLY" matches.
    expect(result[0].phase).toBe("REPLY");
    expect(result[0].llmCalls).toBe(1);
  });

  it("limits the per-detail fetches to the first 5 trajectories", async () => {
    const calls: RecordedCall[] = [];
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `t${i}`,
      status: "completed",
      llmCallCount: 0,
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, method: init?.method ?? "GET" });
        if (url.startsWith("/api/trajectories?")) {
          return {
            ok: true,
            json: async () => ({
              trajectories: many,
              total: 8,
              offset: 0,
              limit: 10,
            }),
          } as unknown as Response;
        }
        const id = decodeURIComponent(url.split("/api/trajectories/")[1] ?? "");
        return {
          ok: true,
          json: async () => ({
            trajectory: { id, status: "completed" },
            llmCalls: [],
            providerAccesses: [],
            toolEvents: [],
            evaluationEvents: [],
          }),
        } as unknown as Response;
      }),
    );
    const result = (await interact("filter-phase")) as unknown[];
    expect(result).toHaveLength(5);
    expect(
      calls.filter((c) => c.url.startsWith("/api/trajectories/")),
    ).toHaveLength(5);
  });
});

describe("interact unknown capability", () => {
  it("throws the exact 'does not support' message", async () => {
    installFetch();
    await expect(interact("teleport")).rejects.toThrow(
      'Trajectory Logger TUI does not support "teleport".',
    );
  });
});
