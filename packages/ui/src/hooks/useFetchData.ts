/**
 * useFetchData — canonical wrapper for the "fetch in an effect" pattern.
 *
 * Replaces the ~35 ad-hoc `useEffect(() => { let cancelled = false; ... })`
 * implementations scattered across the dashboard. Always passes an
 * `AbortSignal` to the fetcher so an in-flight request is cancelled on
 * unmount or when `deps` change.
 *
 * AbortError is treated as silent: a cancelled request never lands in
 * `error` state. Every other failure surfaces — this hook does NOT
 * swallow real errors.
 *
 * Initial state is `loading` (not `idle`) since the effect always fires on
 * mount. The `idle` variant is reserved in the type for a future opt-out
 * flag but never surfaces today.
 */

import { useCallback, useEffect, useRef, useState } from "react";

export type FetchState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "success"; data: T }
  | { status: "error"; error: Error };

export type FetchMutator<T> = {
  (next: T): void;
  (updater: (prev: T) => T): void;
};

export type UseFetchDataResult<T> = FetchState<T> & {
  refetch: () => void;
  mutate: FetchMutator<T>;
};

function isAbortError(value: unknown): boolean {
  if (value instanceof DOMException && value.name === "AbortError") return true;
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    (value as { name?: unknown }).name === "AbortError"
  ) {
    return true;
  }
  return false;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string") return new Error(value);
  return new Error(
    typeof value === "object" && value !== null
      ? JSON.stringify(value)
      : String(value),
  );
}

function isUpdaterFn<T>(value: T | ((prev: T) => T)): value is (prev: T) => T {
  return typeof value === "function";
}

export function useFetchData<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: ReadonlyArray<unknown>,
): UseFetchDataResult<T> {
  const [state, setState] = useState<FetchState<T>>({ status: "loading" });
  const [reloadTick, setReloadTick] = useState(0);

  // Capture the latest fetcher so a refetch / deps change does not need to
  // include `fetcher` in its dependency list. Callers commonly pass inline
  // arrow functions; including `fetcher` in `deps` would re-run on every
  // render.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const refetch = useCallback(() => {
    setReloadTick((tick) => tick + 1);
  }, []);

  const mutate = useCallback<FetchMutator<T>>((next: T | ((prev: T) => T)) => {
    setState((prev) => {
      if (isUpdaterFn(next)) {
        if (prev.status !== "success") {
          throw new Error(
            "useFetchData: mutate(updaterFn) called without prior data " +
              `(current status: ${prev.status}). Pass a value of T directly, ` +
              "or wait until status === 'success'.",
          );
        }
        return { status: "success", data: next(prev.data) };
      }
      return { status: "success", data: next };
    });
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  // `deps` is the intentional dependency list passed by the caller;
  // `reloadTick` is a monotonically-increasing counter that forces a refetch
  // when `refetch()` is called. Both are legitimate dep-array entries even
  // though `reloadTick` is not read inside the effect body.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadTick is an intentional trigger dep, not a used value
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });

    fetcherRef
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: "success", data });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        if (isAbortError(err)) return;
        setState({ status: "error", error: toError(err) });
      });

    return () => {
      controller.abort();
    };
  }, [...deps, reloadTick]);

  return { ...state, refetch, mutate };
}
