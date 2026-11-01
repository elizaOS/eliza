/**
 * The `filter-phase` TUI capability summarizes the trajectories it lists. It
 * must cover every trajectory the list read returned: a caller cannot tell a
 * silently dropped row from a trajectory that does not exist.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const clientFetch = vi.hoisted(() => vi.fn());

vi.mock("@elizaos/ui", async () => {
  const core = await import(
    "../../../packages/ui/src/api/client-types-core.ts"
  );
  return {
    client: { fetch: clientFetch },
    isApiError: core.isApiError,
  };
});

import { interact } from "../src/components/TrajectoryLoggerView.interact.ts";

const ids = Array.from({ length: 10 }, (_, index) => `t-${index + 1}`);

beforeEach(() => {
  clientFetch.mockReset();
  clientFetch.mockImplementation((path: string) => {
    if (path.startsWith("/api/trajectories?")) {
      const limit = Number(
        new URL(path, "http://localhost").searchParams.get("limit"),
      );
      return Promise.resolve({
        trajectories: ids.slice(0, limit).map((id) => ({
          id,
          status: "completed" as const,
          llmCallCount: 1,
        })),
        total: ids.length,
      });
    }
    const id = decodeURIComponent(path.split("/").at(-1) ?? "");
    return Promise.resolve({
      trajectory: { id, status: "completed" as const, llmCallCount: 1 },
      llmCalls: [
        {
          id: `${id}-call`,
          model: "test-model",
          response: "",
          purpose: "",
          actionType: "",
          stepType: "should_respond",
        },
      ],
      providerAccesses: [],
      toolEvents: [],
      evaluationEvents: [],
    });
  });
});

describe("filter-phase capability", () => {
  it("summarizes every trajectory the list read returned", async () => {
    const result = (await interact("filter-phase", { phase: "HANDLE" })) as {
      id: string;
      llmCalls: number;
    }[];

    expect(result.map((row) => row.id)).toEqual(ids);
    expect(result.every((row) => row.llmCalls === 1)).toBe(true);
  });

  it("applies the caller's limit to the list read", async () => {
    const result = (await interact("filter-phase", {
      phase: "HANDLE",
      limit: 3,
    })) as { id: string }[];

    expect(result.map((row) => row.id)).toEqual(ids.slice(0, 3));
    expect(clientFetch.mock.calls[0]?.[0]).toBe("/api/trajectories?limit=3");
  });
});
