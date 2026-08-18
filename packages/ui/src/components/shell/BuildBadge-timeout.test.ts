/**
 * Behavioral BuildBadge build-info JSON deadline. Executes
 * getBuildInfoJsonWithFetch under abort — not a source-grep of BuildBadge.tsx.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("lucide-react", () => ({
  X: () => null,
}));

vi.mock("../../lib/floating-layers", () => ({
  Z_BUILD_BADGE: 1,
}));

vi.mock("../../platform/standalone-bottom-reclaim", () => ({
  getStandaloneBottomReclaimState: () => ({ reclaimPx: 0 }),
}));

import {
  BUILD_BADGE_JSON_TIMEOUT_MS,
  BUILD_INFO_URL,
  getBuildInfoJsonWithFetch,
} from "./BuildBadge";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected build-badge abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("BuildBadge build-info JSON deadline", () => {
  it("keeps a documented UI JSON budget", () => {
    expect(BUILD_BADGE_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled build-info GET at the injected deadline", async () => {
    await expect(
      getBuildInfoJsonWithFetch(BUILD_INFO_URL, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed build-info GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    await expect(
      getBuildInfoJsonWithFetch(BUILD_INFO_URL, fetchImpl, 1_000),
    ).rejects.toThrow("503");
  });

  it("uses the injected fetch for a successful build-info GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({ commit: "58f6bb3beb", label: "stamp" });
    };

    const body = await getBuildInfoJsonWithFetch<{
      commit: string;
      label: string;
    }>(BUILD_INFO_URL, fetchImpl, 1_000);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(body).toEqual({ commit: "58f6bb3beb", label: "stamp" });
  });
});
