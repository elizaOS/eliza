/**
 * @vitest-environment jsdom
 *
 * Exercises InboxView JSON deadlines and caller cancellation through the
 * injectable HTTP boundary.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui/api", () => ({
  client: { getBaseUrl: () => "http://test.local" },
}));

import {
  getInboxJsonWithFetch,
  INBOX_VIEW_JSON_TIMEOUT_MS,
} from "./InboxView.js";

const URL = "http://test.local/api/lifeops/inbox";

function stallUntilAborted(): typeof fetch {
  return ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) throw new Error("expected inbox-view abort signal");
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      });
    })) as typeof fetch;
}

describe("InboxView inbox JSON deadline", () => {
  it("keeps a documented UI JSON budget", () => {
    expect(INBOX_VIEW_JSON_TIMEOUT_MS).toBe(15_000);
  });

  it("aborts a stalled inbox GET at the injected deadline", async () => {
    await expect(
      getInboxJsonWithFetch(URL, stallUntilAborted(), 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("surfaces a provider error from a completed inbox GET", async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response("nope", { status: 503, statusText: "Service Unavailable" });

    await expect(getInboxJsonWithFetch(URL, fetchImpl, 1_000)).rejects.toThrow(
      "503",
    );
  });

  it("preserves caller cancellation instead of reporting a timeout", async () => {
    const controller = new AbortController();
    const reason = new DOMException("view unmounted", "AbortError");
    const pending = getInboxJsonWithFetch(
      URL,
      stallUntilAborted(),
      1_000,
      controller.signal,
    );

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it("uses the injected fetch for a successful inbox GET", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.signal) signals.push(init.signal);
      return Response.json({
        messages: [],
        channelCounts: {},
        fetchedAt: "2026-08-18T00:00:00.000Z",
        sources: [],
      });
    };

    const body = await getInboxJsonWithFetch<{ fetchedAt: string }>(
      URL,
      fetchImpl,
      1_000,
    );

    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(body.fetchedAt).toBe("2026-08-18T00:00:00.000Z");
  });
});
