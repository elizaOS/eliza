/**
 * @vitest-environment jsdom
 *
 * GoalsView goals JSON through the canonical ElizaClient seam.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const { clientFetch } = vi.hoisted(() => ({
  clientFetch: vi.fn(),
}));

vi.mock("@elizaos/ui/api", () => ({
  client: {
    fetch: clientFetch,
    getBaseUrl: () => "http://test.local",
  },
}));

vi.mock("./GoalsSpatialView.tsx", () => ({
  GoalsSpatialView: () => null,
}));

import {
  GOALS_VIEW_JSON_TIMEOUT_MS,
  getGoalsJsonWithClient,
} from "./GoalsView.js";

const PATH = "/api/lifeops/goals";

describe("GoalsView goals JSON deadline", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("keeps a documented UI JSON budget", () => {
    expect(GOALS_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("surfaces a timeout from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new DOMException("The operation timed out", "TimeoutError"),
    );

    await expect(
      getGoalsJsonWithClient(PATH, { fetch: clientFetch }, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 10,
    });
  });

  it("surfaces a provider error from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(new Error("Goals request failed (503)"));

    await expect(
      getGoalsJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the bounded client path for a successful goals GET", async () => {
    clientFetch.mockResolvedValueOnce({ goals: [] });

    await expect(
      getGoalsJsonWithClient(PATH, { fetch: clientFetch }, 1_000),
    ).resolves.toEqual({ goals: [] });
    expect(clientFetch).toHaveBeenCalledWith(PATH, undefined, {
      timeoutMs: 1_000,
    });
  });
});
