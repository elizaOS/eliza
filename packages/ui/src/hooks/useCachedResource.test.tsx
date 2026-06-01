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
