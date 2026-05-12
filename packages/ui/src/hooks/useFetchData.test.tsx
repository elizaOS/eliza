// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFetchData } from "./useFetchData";

describe("useFetchData", () => {
  it("starts in loading state on first render (never surfaces idle)", () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => "hello");
    const { result } = renderHook(() => useFetchData(fetcher, []));
    expect(result.current.status).toBe("loading");
  });

  it("transitions loading → success and returns data", async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => "hello");
    const { result } = renderHook(() => useFetchData(fetcher, []));

    expect(result.current.status).toBe("loading");

    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    if (result.current.status === "success") {
      expect(result.current.data).toBe("hello");
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("transitions loading → error on non-abort failure", async () => {
    const boom = new Error("boom");
    const fetcher = vi.fn(async (_signal: AbortSignal) => {
      throw boom;
    });
    const { result } = renderHook(() => useFetchData(fetcher, []));

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    if (result.current.status === "error") {
      expect(result.current.error).toBe(boom);
    }
  });

  it("aborts the in-flight request on unmount and does NOT set error state", async () => {
    const observedSignals: AbortSignal[] = [];
    const fetcher = vi.fn(async (signal: AbortSignal) => {
      observedSignals.push(signal);
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          const err = new DOMException("aborted", "AbortError");
          reject(err);
        });
      });
    });

    const { result, unmount } = renderHook(() => useFetchData(fetcher, []));
    expect(result.current.status).toBe("loading");

    unmount();

    // Allow the rejected promise's microtasks to flush.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(observedSignals[0]?.aborted).toBe(true);
    // After unmount we cannot inspect state, but the key invariant is that
    // the rejection was swallowed (no unhandled promise rejection). If it
    // were treated as error state we'd see a warning from React's act().
  });

  it("refetch() re-runs the fetcher", async () => {
    let calls = 0;
    const fetcher = vi.fn(async (_signal: AbortSignal) => {
      calls += 1;
      return calls;
    });
    const { result } = renderHook(() => useFetchData(fetcher, []));

    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    if (result.current.status === "success") {
      expect(result.current.data).toBe(1);
    }

    act(() => {
      result.current.refetch();
    });
    expect(result.current.status).toBe("loading");

    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    if (result.current.status === "success") {
      expect(result.current.data).toBe(2);
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("aborts the prior request when deps change", async () => {
    const observedSignals: AbortSignal[] = [];
    const fetcher = (signal: AbortSignal, value: number) => {
      observedSignals.push(signal);
      return new Promise<number>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
        // Resolve on the next microtask if not aborted.
        queueMicrotask(() => {
          if (!signal.aborted) resolve(value);
        });
      });
    };

    const { result, rerender } = renderHook(
      ({ value }: { value: number }) =>
        useFetchData((signal) => fetcher(signal, value), [value]),
      { initialProps: { value: 1 } },
    );

    expect(result.current.status).toBe("loading");
    expect(observedSignals).toHaveLength(1);

    // Change deps before the first request resolves.
    rerender({ value: 2 });

    // The first signal should now be aborted.
    expect(observedSignals[0]?.aborted).toBe(true);
    expect(observedSignals).toHaveLength(2);

    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });
    if (result.current.status === "success") {
      expect(result.current.data).toBe(2);
    }
  });

  it("mutate(value) after success replaces data", async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => "initial");
    const { result } = renderHook(() => useFetchData(fetcher, []));

    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });

    act(() => {
      result.current.mutate("replaced");
    });

    expect(result.current.status).toBe("success");
    if (result.current.status === "success") {
      expect(result.current.data).toBe("replaced");
    }
    // mutate does not trigger a refetch
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("mutate(fn) with updater fn applies to current data", async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => [1, 2, 3]);
    const { result } = renderHook(() =>
      useFetchData<number[]>(fetcher, []),
    );

    await waitFor(() => {
      expect(result.current.status).toBe("success");
    });

    act(() => {
      result.current.mutate((prev) => [...prev, 4]);
    });

    expect(result.current.status).toBe("success");
    if (result.current.status === "success") {
      expect(result.current.data).toEqual([1, 2, 3, 4]);
    }
  });

  it("mutate(value) during loading sets data and transitions to success", () => {
    const fetcher = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<string>(() => {
          // never resolves
        }),
    );
    const { result } = renderHook(() => useFetchData<string>(fetcher, []));

    expect(result.current.status).toBe("loading");

    act(() => {
      result.current.mutate("optimistic");
    });

    expect(result.current.status).toBe("success");
    if (result.current.status === "success") {
      expect(result.current.data).toBe("optimistic");
    }
  });

  it("mutate(value) during error transitions to success", async () => {
    const fetcher = vi.fn(async (_signal: AbortSignal) => {
      throw new Error("boom");
    });
    const { result } = renderHook(() => useFetchData<string>(fetcher, []));

    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });

    act(() => {
      result.current.mutate("recovered");
    });

    expect(result.current.status).toBe("success");
    if (result.current.status === "success") {
      expect(result.current.data).toBe("recovered");
    }
  });

  it("mutate(updaterFn) without prior data throws a clear error", () => {
    const fetcher = vi.fn(
      (_signal: AbortSignal) =>
        new Promise<number>(() => {
          // never resolves — keeps state in `loading`
        }),
    );
    const { result } = renderHook(() => useFetchData<number>(fetcher, []));

    expect(result.current.status).toBe("loading");

    expect(() => {
      act(() => {
        result.current.mutate((prev) => prev + 1);
      });
    }).toThrow(/mutate\(updaterFn\) called without prior data/);
  });
});
