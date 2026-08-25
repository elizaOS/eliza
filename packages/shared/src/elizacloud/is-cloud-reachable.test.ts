/**
 * Unit test coverage for boot-time Eliza Cloud reachability probe
 * in is-cloud-reachable.ts.
 *
 * Exercises HTTP HEAD probe behavior across 200 OK, 4xx/5xx responses,
 * network rejection, timeouts, and concurrent promise memoization.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("is-cloud-reachable", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("resolves true when cloud HEAD request returns 200 OK", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { isCloudReachable } = await import("./is-cloud-reachable.js");
    const reachable = await isCloudReachable();

    expect(reachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        method: "HEAD",
        redirect: "manual",
      }),
    );
  });

  it("resolves true when cloud HEAD request returns non-2xx status (host responded)", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 404 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { isCloudReachable } = await import("./is-cloud-reachable.js");
    const reachable = await isCloudReachable();

    expect(reachable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves false when fetch throws a network failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { isCloudReachable } = await import("./is-cloud-reachable.js");
    const reachable = await isCloudReachable();

    expect(reachable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves false when probe times out / aborts", async () => {
    const fetchMock = vi.fn(async () => {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { isCloudReachable } = await import("./is-cloud-reachable.js");
    const reachable = await isCloudReachable();

    expect(reachable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("memoizes the in-flight probe across multiple concurrent callers", async () => {
    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(null, { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { isCloudReachable } = await import("./is-cloud-reachable.js");
    const [res1, res2, res3] = await Promise.all([
      isCloudReachable(),
      isCloudReachable(),
      isCloudReachable(),
    ]);

    expect(res1).toBe(true);
    expect(res2).toBe(true);
    expect(res3).toBe(true);
    expect(callCount).toBe(1);
  });
});
