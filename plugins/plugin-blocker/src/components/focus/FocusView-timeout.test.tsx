/**
 * @vitest-environment jsdom
 *
 * Behavioral FocusView website-blocker JSON deadline. Executes
 * getFocusJsonWithFetch under abort — not a source-grep of FocusView.tsx.
 */

import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui/api", () => ({
  client: { getBaseUrl: () => "http://test.local" },
}));

vi.mock("./FocusSpatialView.tsx", () => ({
  FocusSpatialView: () => null,
}));

import {
  FOCUS_VIEW_JSON_TIMEOUT_MS,
  FocusView,
  getFocusJsonWithFetch,
} from "./FocusView.js";

const URL = "http://test.local/api/website-blocker";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected focus-view abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("FocusView website-blocker JSON deadline", () => {
  it("aborts the active request on unmount", () => {
    let signal: AbortSignal | undefined;
    const view = render(
      <FocusView
        fetchStatus={(nextSignal) => {
          signal = nextSignal;
          return new Promise(() => {});
        }}
      />,
    );
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("keeps a documented UI JSON budget", () => {
    expect(FOCUS_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled status GET at the injected deadline", async () => {
    await expect(
      getFocusJsonWithFetch(URL, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed status GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    await expect(getFocusJsonWithFetch(URL, fetchImpl, 1_000)).rejects.toThrow(
      "503",
    );
  });

  it("uses the injected fetch for a successful status GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({
        available: true,
        active: false,
        platform: "linux",
      });
    };

    const body = await getFocusJsonWithFetch<{
      available: boolean;
      platform: string;
    }>(URL, fetchImpl, 1_000);

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(body.available).toBe(true);
    expect(body.platform).toBe("linux");
  });

  it("composes a caller abort signal with the deadline", async () => {
    const controller = new AbortController();
    const request = getFocusJsonWithFetch(
      URL,
      stallUntilAborted(),
      1_000,
      controller.signal,
    );
    controller.abort();
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });
});
