/** Verifies useCachedResource through the package's configured test harness. */
// @vitest-environment jsdom

import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetResourceCache } from "./resource-cache";
import { useCachedResource } from "./useCachedResource";

afterEach(() => {
  __resetResourceCache();
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

  it("null key disables the resource: loading forever, no fetch, safe no-op controls", async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => "v1");
    const { result } = renderHook(() => useCachedResource(null, fetcher));

    expect(result.current.status).toBe("loading");
    await new Promise((r) => setTimeout(r, 0));
    expect(fetcher).not.toHaveBeenCalled();

    await expect(result.current.refetch()).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    // A disabled resource has no cache slot, but mutate(updaterFn) must not
    // take the missing-data throw path — the null-key guard runs first.
    expect(() => result.current.mutate((prev: string) => prev)).not.toThrow();
    expect(result.current.status).toBe("loading");
  });

  it("enabled:false skips mount revalidation on a cold cache", async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => "v1");
    const { result } = renderHook(() =>
      useCachedResource("k-disabled-cold", fetcher, { enabled: false }),
    );

    expect(result.current.status).toBe("loading");
    await new Promise((r) => setTimeout(r, 0));
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.status).toBe("loading");
  });

  it("enabled:false still paints an already cached value without fetching", async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => "v1");
    const warm = renderHook(() =>
      useCachedResource("k-disabled-warm", fetcher, { staleTime: 10_000 }),
    );
    await waitFor(() => expect(warm.result.current.status).toBe("success"));
    warm.unmount();
    fetcher.mockClear();

    const second = renderHook(() =>
      useCachedResource("k-disabled-warm", fetcher, {
        enabled: false,
        staleTime: 10_000,
      }),
    );
    expect(second.result.current.status).toBe("success");
    if (second.result.current.status === "success") {
      expect(second.result.current.data).toBe("v1");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("a rejected cold fetch surfaces the error state with a normalized message", async () => {
    let reject: (e: unknown) => void = () => {};
    const fetcher = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((_r, rej) => {
          reject = rej;
        }),
    );
    const { result } = renderHook(() =>
      useCachedResource("k-error", fetcher, { staleTime: 10_000 }),
    );

    expect(result.current.isValidating).toBe(true);
    reject("boom");
    await waitFor(() => expect(result.current.status).toBe("error"));
    if (result.current.status === "error") {
      // Non-Error rejections are wrapped so callers always get .message.
      expect(result.current.error.message).toBe("boom");
    }
    expect(result.current.isValidating).toBe(false);
  });

  it("a failed forced refetch keeps the previous cached value visible", async () => {
    let shouldFail = false;
    const fetcher = vi.fn((_signal: AbortSignal) =>
      shouldFail
        ? Promise.reject(new Error("net down"))
        : Promise.resolve("v1"),
    );
    const { result } = renderHook(() =>
      useCachedResource("k-stale-on-error", fetcher, { staleTime: 10_000 }),
    );
    await waitFor(() => expect(result.current.status).toBe("success"));

    shouldFail = true;
    // The returned promise never rejects — failures land in state instead.
    await result.current.refetch();
    // With a cached value present, success outranks the recorded error.
    expect(result.current.status).toBe("success");
    if (result.current.status === "success") {
      expect(result.current.data).toBe("v1");
    }
    expect(result.current.isValidating).toBe(false);
  });

  it("recovers to success when a refetch succeeds after a failure", async () => {
    let attempt = 0;
    const fetcher = vi.fn((_signal: AbortSignal) => {
      attempt += 1;
      if (attempt === 1) return Promise.reject(new Error("cold fail"));
      return Promise.resolve("recovered");
    });
    const { result } = renderHook(() =>
      useCachedResource("k-recover", fetcher, { staleTime: 10_000 }),
    );
    await waitFor(() => expect(result.current.status).toBe("error"));

    await result.current.refetch();
    await waitFor(() => expect(result.current.status).toBe("success"));
    if (result.current.status === "success") {
      expect(result.current.data).toBe("recovered");
    }
    expect(result.current.isValidating).toBe(false);
  });

  it("mutate replaces the cached value immediately", async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => "v1");
    const { result } = renderHook(() =>
      useCachedResource("k-mutate-set", fetcher, { staleTime: 10_000 }),
    );
    await waitFor(() => expect(result.current.status).toBe("success"));

    result.current.mutate("optimistic");
    await waitFor(() => {
      if (result.current.status === "success") {
        expect(result.current.data).toBe("optimistic");
      }
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("mutate accepts an updater function derived from current data", async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => "v1");
    const { result } = renderHook(() =>
      useCachedResource("k-mutate-updater", fetcher, { staleTime: 10_000 }),
    );
    await waitFor(() => expect(result.current.status).toBe("success"));

    result.current.mutate((prev: string) => `${prev}!`);
    await waitFor(() => {
      if (result.current.status === "success") {
        expect(result.current.data).toBe("v1!");
      }
    });
  });

  it("mutate(updaterFn) without cached data throws", () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => "v1");
    const { result } = renderHook(() =>
      useCachedResource("k-mutate-missing", fetcher, { enabled: false }),
    );
    expect(() => result.current.mutate((prev: string) => `${prev}!`)).toThrow(
      "useCachedResource: mutate(updaterFn) called without cached data.",
    );
  });

  it("isValidating tracks an in-flight revalidation", async () => {
    let resolve: (v: string) => void = () => {};
    const fetcher = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>((r) => {
          resolve = r;
        }),
    );
    const { result } = renderHook(() =>
      useCachedResource("k-validating", fetcher),
    );

    expect(result.current.isValidating).toBe(true);
    resolve("v1");
    await waitFor(() => expect(result.current.isValidating).toBe(false));
    await waitFor(() => expect(result.current.status).toBe("success"));
  });

  it("persist mirrors to localStorage so a wiped memory cache still paints instantly", async () => {
    const storageKey = "eliza:rc:k-persist";
    window.localStorage.removeItem(storageKey);
    try {
      const fetcher = vi.fn(async (_signal: AbortSignal) => "v1");
      const first = renderHook(() =>
        useCachedResource("k-persist", fetcher, {
          persist: true,
          staleTime: 10_000,
        }),
      );
      await waitFor(() => expect(first.result.current.status).toBe("success"));
      expect(window.localStorage.getItem(storageKey)).not.toBeNull();
      first.unmount();

      // Simulate a reload: the in-memory store is gone, the mirror survives.
      __resetResourceCache();
      fetcher.mockClear();

      const second = renderHook(() =>
        useCachedResource("k-persist", fetcher, {
          persist: true,
          staleTime: 10_000,
        }),
      );
      expect(second.result.current.status).toBe("success");
      if (second.result.current.status === "success") {
        expect(second.result.current.data).toBe("v1");
      }
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      window.localStorage.removeItem(storageKey);
    }
  });
});
