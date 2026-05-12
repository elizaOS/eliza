// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useFetchData } from "./useFetchData";

describe("useFetchData", () => {
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
});
