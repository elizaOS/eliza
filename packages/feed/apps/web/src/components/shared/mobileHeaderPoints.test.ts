import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import {
  fetchMobileHeaderPointsSnapshot,
  isAbortError,
} from "./mobileHeaderPoints";

describe("fetchMobileHeaderPointsSnapshot", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns the balance and reputation points when both requests succeed", async () => {
    const fetchMock = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.endsWith("/balance")) {
        return Promise.resolve(
          new Response(JSON.stringify({ balance: "125.5" }), { status: 200 }),
        );
      }

      expect(url.endsWith("/profile")).toBe(true);
      expect(new Headers(init?.headers).get("Authorization")).toBe(
        "Bearer token-123",
      );

      return Promise.resolve(
        new Response(
          JSON.stringify({
            user: {
              reputationPoints: 77,
            },
          }),
          { status: 200 },
        ),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await fetchMobileHeaderPointsSnapshot({
      userId: "user-1",
      token: "token-123",
      signal: new AbortController().signal,
    });

    expect(snapshot).toEqual({
      available: 125.5,
      reputationPoints: 77,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps partial data when one request fails with a network error", async () => {
    const fetchMock = mock((input: RequestInfo | URL) => {
      const url = String(input);

      if (url.endsWith("/balance")) {
        return Promise.reject(new TypeError("Load failed"));
      }

      return Promise.resolve(
        new Response(
          JSON.stringify({
            user: {
              reputationPoints: 42,
            },
          }),
          { status: 200 },
        ),
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const snapshot = await fetchMobileHeaderPointsSnapshot({
      userId: "user-1",
      token: "token-123",
      signal: new AbortController().signal,
    });

    expect(snapshot).toEqual({
      available: null,
      reputationPoints: 42,
    });
  });

  it("preserves AbortError rejections so callers can ignore intentional aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortError = new DOMException(
      "The user aborted a request.",
      "AbortError",
    );

    globalThis.fetch = mock().mockRejectedValue(
      abortError,
    ) as unknown as typeof fetch;

    expect(isAbortError(abortError)).toBe(true);
    await expect(
      fetchMobileHeaderPointsSnapshot({
        userId: "user-1",
        token: "token-123",
        signal: controller.signal,
      }),
    ).rejects.toBe(abortError);
  });
});
