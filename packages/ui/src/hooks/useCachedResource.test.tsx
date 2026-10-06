/** Verifies useCachedResource through the package's configured test harness. */
// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import {
  __resetResourceCache,
  setCached,
  startPolling,
} from "./resource-cache";
import { useCachedResource } from "./useCachedResource";

afterEach(() => {
  cleanup();
  __resetResourceCache();
  vi.useRealTimers();
});

describe("useCachedResource", () => {
  it("cold start: loading → success", async () => {
    let resolve: (v: string) => void = () => {};
    const fetcher = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const { result } = renderHook(() =>
      useCachedResource("k-cold", fetcher, { staleTime: 10_000 }),
    );

    // Cold cache → no value to paint, so the first render is loading.
    expect(result.current.status).toBe("loading");
    resolve("v1");
    await waitFor(() => expect(result.current.status).toBe("success"));
    if (result.current.status === "success") {
      expect(result.current.data).toBe("v1");
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("revisit paints instantly from cache (no loading flash) and skips refetch while fresh", async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => "v1");
    const first = renderHook(() =>
      useCachedResource("k-warm", fetcher, { staleTime: 10_000 }),
    );
    await waitFor(() => expect(first.result.current.status).toBe("success"));
    first.unmount();

    // Second mount of the same key: the very first render is already success.
    const second = renderHook(() =>
      useCachedResource("k-warm", fetcher, { staleTime: 10_000 }),
    );
    expect(second.result.current.status).toBe("success");
    if (second.result.current.status === "success") {
      expect(second.result.current.data).toBe("v1");
    }
    // Fresh within staleTime → no second network call.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("de-duplicates concurrent revalidations for the same key", async () => {
    let resolve: (v: string) => void = () => {};
    const fetcher = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );

    const a = renderHook(() => useCachedResource("k-dedup", fetcher));
    const b = renderHook(() => useCachedResource("k-dedup", fetcher));

    // Two mounts, one shared in-flight request.
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolve("shared");
    await waitFor(() => expect(a.result.current.status).toBe("success"));
    await waitFor(() => expect(b.result.current.status).toBe("success"));
    if (a.result.current.status === "success") {
      expect(a.result.current.data).toBe("shared");
    }
    if (b.result.current.status === "success") {
      expect(b.result.current.data).toBe("shared");
    }
  });

  it("refetch forces revalidation even when the cached value is fresh", async () => {
    let value = "v1";
    const fetcher = vi.fn(async (_signal: AbortSignal) => value);
    const { result } = renderHook(() =>
      useCachedResource("k-refetch", fetcher, { staleTime: 10_000 }),
    );

    await waitFor(() => expect(result.current.status).toBe("success"));
    value = "v2";
    result.current.refetch();

    await waitFor(() => {
      if (result.current.status === "success") {
        expect(result.current.data).toBe("v2");
      }
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refetch() settles only after the fresh value is committed to the cache", async () => {
    let resolveInitial: (v: string) => void = () => {};
    let resolveRefetch: (v: string) => void = () => {};
    let call = 0;
    const fetcher = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((r) => {
          call += 1;
          if (call === 1) resolveInitial = r;
          else resolveRefetch = r;
        }),
    );
    const { result } = renderHook(() =>
      useCachedResource("k-refetch-await", fetcher, { staleTime: 10_000 }),
    );
    resolveInitial("v1");
    await waitFor(() => expect(result.current.status).toBe("success"));

    // Consumers (e.g. useViewCatalog's install flow) `await refetch()` before
    // clearing optimistic UI — the promise must not resolve while the refetch
    // is still in flight, or they resume against stale data.
    let settled = false;
    const pending = result.current.refetch().then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);

    resolveRefetch("v2");
    await pending;
    await waitFor(() => {
      if (result.current.status === "success") {
        expect(result.current.data).toBe("v2");
      }
    });
  });

  it("revalidates stale data in the background while showing the cached value", async () => {
    let value = "v1";
    const fetcher = vi.fn(async (_signal: AbortSignal) => value);
    const first = renderHook(() =>
      useCachedResource("k-stale", fetcher, { staleTime: 0 }),
    );
    await waitFor(() => expect(first.result.current.status).toBe("success"));
    first.unmount();

    value = "v2";
    const second = renderHook(() =>
      useCachedResource("k-stale", fetcher, { staleTime: 0 }),
    );
    // Instant paint of the stale value...
    expect(second.result.current.status).toBe("success");
    if (second.result.current.status === "success") {
      expect(second.result.current.data).toBe("v1");
    }
    // ...then background revalidation swaps in the fresh value.
    await waitFor(() => {
      if (second.result.current.status === "success") {
        expect(second.result.current.data).toBe("v2");
      }
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

test("disabled resource does not expose cached data (documented contract)", () => {
  setCached("review-disabled", { value: 42 });
  const fetcher = vi.fn();
  const { result } = renderHook(() =>
    useCachedResource("review-disabled", fetcher, { enabled: false }),
  );
  expect(fetcher).not.toHaveBeenCalled();
  expect(result.current.status).toBe("loading");
});
test("polling deduplicates a still-pending request (documented contract)", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise(() => {}));
  const stop = startPolling("review-poll", fetcher, 100);
  await vi.advanceTimersByTimeAsync(300);
  stop();
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test("a failure for a previous key cannot replace the current key loading state", async () => {
  let failA!: (e: Error) => void;
  const a = new Promise<never>((_, reject) => {
    failA = reject;
  });
  const b = new Promise<never>(() => {});
  const { result, rerender } = renderHook(
    ({ key }) => useCachedResource(key, () => (key === "review-a" ? a : b)),
    { initialProps: { key: "review-a" } },
  );
  rerender({ key: "review-b" });
  await act(async () => {
    failA(new Error("A failed"));
    await Promise.resolve();
  });
  expect(result.current.status).toBe("loading");
  expect(result.current.isValidating).toBe(true);
});

test("background poll errors are observable without losing cached data and clear on recovery", async () => {
  vi.useFakeTimers();
  setCached("poll-error", "cached");
  const failure = new Error("offline");
  const fetcher = vi
    .fn<() => Promise<string>>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValue("cached");
  const { result } = renderHook(() => useCachedResource("poll-error", fetcher));
  const stop = startPolling("poll-error", fetcher, 100);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(result.current).toMatchObject({
    status: "success",
    data: "cached",
    revalidationError: failure,
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(result.current).toMatchObject({
    status: "success",
    data: "cached",
    revalidationError: null,
  });
  stop();
  expect(vi.getTimerCount()).toBe(0);
});

test("disabled transitions hide the cache and disable explicit refetch and mutation", async () => {
  setCached("disabled-transition", "original");
  const fetcher = vi.fn(async () => "fetched");
  const { result, rerender } = renderHook(
    ({ enabled }) =>
      useCachedResource("disabled-transition", fetcher, { enabled }),
    { initialProps: { enabled: true } },
  );
  expect(result.current).toMatchObject({ status: "success", data: "original" });
  rerender({ enabled: false });
  await act(async () => {
    await result.current.refetch();
    result.current.mutate("changed");
  });
  expect(result.current).toMatchObject({
    status: "loading",
    isValidating: false,
    revalidationError: null,
  });
  rerender({ enabled: true });
  expect(result.current).toMatchObject({ status: "success", data: "original" });
  expect(fetcher).not.toHaveBeenCalled();
});

test("a synchronous fetcher failure follows the same error path as a rejected promise", async () => {
  const failure = new Error("synchronous fetch failure");
  const { result } = renderHook(() =>
    useCachedResource("sync-failure", () => {
      throw failure;
    }),
  );
  await waitFor(() =>
    expect(result.current).toMatchObject({
      status: "error",
      error: failure,
      isValidating: false,
    }),
  );
});
