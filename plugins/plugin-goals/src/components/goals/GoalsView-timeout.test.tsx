/**
 * @vitest-environment jsdom
 *
 * Behavioral GoalsView goals-JSON deadline. Executes getGoalsJsonWithFetch
 * under abort — not a source-grep of GoalsView.tsx.
 */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui/api", () => ({
  client: { getBaseUrl: () => "http://test.local" },
}));

vi.mock("./GoalsSpatialView.tsx", () => ({
  GoalsSpatialView: () => null,
}));

import {
  GOALS_VIEW_JSON_TIMEOUT_MS,
  GoalsView,
  getGoalsJsonWithFetch,
} from "./GoalsView.js";

const URL = "http://test.local/api/lifeops/goals";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected goals-view abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("GoalsView goals JSON deadline", () => {
  it("aborts the active request on unmount", () => {
    let signal: AbortSignal | undefined;
    const view = render(
      <GoalsView
        fetchers={{
          fetchGoals: (nextSignal) => {
            signal = nextSignal;
            return new Promise(() => {});
          },
        }}
      />,
    );
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("keeps a documented UI JSON budget", () => {
    expect(GOALS_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled goals GET at the injected deadline", async () => {
    await expect(
      getGoalsJsonWithFetch(URL, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed goals GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    await expect(getGoalsJsonWithFetch(URL, fetchImpl, 1_000)).rejects.toThrow(
      "503",
    );
  });

  it("uses the injected fetch for a successful goals GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ goals: [] });
    };

    const body = await getGoalsJsonWithFetch<{ goals: unknown[] }>(
      URL,
      fetchImpl,
      1_000,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(body.goals).toEqual([]);
  });

  it("composes a caller abort signal with the deadline", async () => {
    const controller = new AbortController();
    const request = getGoalsJsonWithFetch(
      URL,
      stallUntilAborted(),
      1_000,
      controller.signal,
    );
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
