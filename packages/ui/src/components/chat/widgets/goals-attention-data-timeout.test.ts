/** Verifies goals-attention reads use the bounded canonical UI client. */
import { afterEach, describe, expect, it, vi } from "vitest";

const { clientFetch } = vi.hoisted(() => ({
  clientFetch: vi.fn(),
}));

vi.mock("../../../api", () => ({
  client: {
    fetch: clientFetch,
    getBaseUrl: () => "http://test.local",
  },
}));

vi.mock("../../../api/app-shell-capabilities", () => ({
  supportsFullAppShellRoutes: () => true,
}));

import {
  fetchGoals,
  GOALS_ATTENTION_JSON_TIMEOUT_MS,
} from "./goals-attention-data";

describe("Goals-attention JSON deadline", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("keeps a documented UI JSON budget", () => {
    expect(GOALS_ATTENTION_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("surfaces a timeout from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(
      new DOMException("The operation timed out", "TimeoutError"),
    );

    await expect(fetchGoals()).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from the canonical client", async () => {
    clientFetch.mockRejectedValueOnce(new Error("Goals request failed (503)"));

    await expect(fetchGoals()).rejects.toThrow("503");
  });

  it("uses the bounded client path for a successful goals GET", async () => {
    clientFetch.mockResolvedValueOnce({ goals: [] });

    await expect(fetchGoals()).resolves.toEqual([]);
    expect(clientFetch).toHaveBeenCalledWith("/api/lifeops/goals", undefined, {
      timeoutMs: GOALS_ATTENTION_JSON_TIMEOUT_MS,
    });
  });
});
