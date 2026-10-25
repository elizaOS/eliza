/**
 * Trajectory logger reads must go through the shared app client (selected
 * agent's API base, credentials and transport), never the global `fetch`.
 * The shared client is replaced at the module boundary; `ApiError` is the real
 * class so the unavailable-route classification is checked against the real
 * error shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import { ApiError } from "../../../packages/ui/src/api/client-types-core.ts";
import {
  fetchTrajectoryDetail,
  fetchTrajectoryList,
  fetchTrajectoryTiming,
  isTrajectoryRouteUnavailable,
} from "../src/api-client";

describe("trajectory logger api client", () => {
  const globalFetch = vi.fn(() => {
    throw new Error("global fetch must not be used");
  });

  beforeEach(() => {
    clientFetch.mockReset();
    vi.stubGlobal("fetch", globalFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalFetch.mockClear();
  });

  it("lists trajectories through the shared client with the caller signal and 15s deadline", async () => {
    const result = { trajectories: [], total: 0, offset: 0, limit: 10 };
    clientFetch.mockResolvedValue(result);
    const ctrl = new AbortController();

    await expect(fetchTrajectoryList({ signal: ctrl.signal })).resolves.toBe(
      result,
    );

    expect(clientFetch).toHaveBeenCalledExactlyOnceWith(
      "/api/trajectories?limit=10",
      { method: "GET", signal: ctrl.signal },
      { timeoutMs: 15_000 },
    );
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("encodes the trajectory id in the detail path", async () => {
    clientFetch.mockResolvedValue({ trajectory: { id: "a/b?c" } });

    await fetchTrajectoryDetail("a/b?c");

    expect(clientFetch).toHaveBeenCalledExactlyOnceWith(
      "/api/trajectories/a%2Fb%3Fc",
      { method: "GET", signal: undefined },
      { timeoutMs: 15_000 },
    );
    expect(globalFetch).not.toHaveBeenCalled();
  });

  it("joins timing rows to the trajectory by recorded identity", async () => {
    clientFetch.mockResolvedValue({
      turns: [
        { turnId: "turn-1", spans: [{ meta: { trajectoryId: "t-1" } }] },
        { turnId: "turn-2", spans: [{ meta: { trajectoryId: "t-2" } }] },
      ],
      flows: [{ turnId: "turn-1" }, { turnId: "turn-2" }],
    });

    const timing = await fetchTrajectoryTiming("t-1");

    expect(clientFetch).toHaveBeenCalledExactlyOnceWith(
      "/api/dev/inference-timing?limit=200",
      { method: "GET", signal: undefined },
      { timeoutMs: 15_000 },
    );
    expect(timing.turns.map((turn) => turn.turnId)).toEqual(["turn-1"]);
    expect(timing.flows.map((flow) => flow.turnId)).toEqual(["turn-1"]);
  });

  it("propagates shared-client failures unchanged", async () => {
    const failure = new ApiError({
      kind: "timeout",
      path: "/api/trajectories?limit=10",
      message: "Request timed out after 15000ms",
    });
    clientFetch.mockRejectedValue(failure);

    await expect(fetchTrajectoryList()).rejects.toBe(failure);
  });

  it("classifies only 404 and 503 responses as an unmounted route", () => {
    const http = (status: number) =>
      new ApiError({
        kind: "http",
        path: "/api/trajectories",
        status,
        message: `HTTP ${status}`,
      });

    expect(isTrajectoryRouteUnavailable(http(404))).toBe(true);
    expect(isTrajectoryRouteUnavailable(http(503))).toBe(true);
    expect(isTrajectoryRouteUnavailable(http(401))).toBe(false);
    expect(isTrajectoryRouteUnavailable(http(500))).toBe(false);
    expect(
      isTrajectoryRouteUnavailable(
        new ApiError({
          kind: "timeout",
          path: "/api/trajectories",
          message: "Request timed out after 15000ms",
        }),
      ),
    ).toBe(false);
    expect(isTrajectoryRouteUnavailable(new Error("offline"))).toBe(false);
    expect(isTrajectoryRouteUnavailable({ status: 404 })).toBe(false);
  });
});
