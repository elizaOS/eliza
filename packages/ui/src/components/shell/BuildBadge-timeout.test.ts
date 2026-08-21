/** Exercises the BuildBadge response-body deadline through the rendered component. */
// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as BuildBadgeModule from "./BuildBadge";

vi.mock("lucide-react", () => ({ X: () => null }));
vi.mock("../../lib/floating-layers", () => ({ Z_BUILD_BADGE: 1 }));
vi.mock("../../platform/standalone-bottom-reclaim", () => ({
  getStandaloneBottomReclaimState: () => ({ reclaimPx: 0 }),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.sessionStorage.clear();
});

describe("BuildBadge build-info deadline", () => {
  it("keeps the deadline active while a successful response body stalls", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeoutController.signal);
    let bodyStarted = false;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
        ok: true,
        json: () => {
          bodyStarted = true;
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        },
      })) as unknown as typeof fetch,
    );

    render(createElement(BuildBadgeModule.BuildBadge));
    await waitFor(() => expect(bodyStarted).toBe(true));
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);

    await act(async () => {
      timeoutController.abort(new DOMException("timed out", "TimeoutError"));
      await Promise.resolve();
    });

    expect(screen.queryByTestId("build-badge")).toBeNull();
  });

  it("keeps the optional badge hidden after a provider error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("nope", {
            status: 503,
            statusText: "Service Unavailable",
          }),
      ),
    );

    render(createElement(BuildBadgeModule.BuildBadge));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("build-badge")).toBeNull();
  });
});
