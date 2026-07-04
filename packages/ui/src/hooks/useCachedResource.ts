/**
 * useCachedResource — fetch-on-mount with a shared stale-while-revalidate cache.
 *
 * Drop-in mental model of {@link useFetchData} (same `status`/`data`/`error`/
 * `refetch`/`mutate` surface) but backed by the module-level
 * {@link resource-cache} store. The difference that matters: when the keyed
 * value is already cached, the very first render returns it as `success`, so a
 * revisited view paints instantly and revalidates in the background instead of
 * dropping to a spinner and re-fetching cold.
 *
 * Semantics:
 *   - Cached value present  → `success` immediately; a background revalidation
 *     runs unless the value is younger than `staleTime`.
 *   - No cached value       → `loading` until the first fetch resolves.
 *   - Concurrent consumers of the same key share one in-flight request.
 *   - `key === null` disables the resource (renders `loading`, fetches nothing).
 *
 * Passing the same `key` from multiple components (or mounting/unmounting the
 * same view repeatedly) is the whole point — they share one cache slot.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { getCached, revalidate, setCached, subscribe } from "./resource-cache";
import type { FetchMutator, FetchState } from "./useFetchData";

export interface CachedResourceOptions {
  /**
   * How long a cached value is considered fresh. Within this window a revisit
   * skips revalidation entirely (truly instant). Default 30s.
   */
  staleTime?: number;
  /** When false, the resource neither reads nor fetches. Default true. */
  enabled?: boolean;
  /** Mirror successful values to localStorage for cross-reload warmth. */
  persist?: boolean;
}

// FetchState is a discriminated union intersected with helpers, so this is a
// type intersection (an interface cannot extend a union-based alias). It
// mirrors UseFetchDataResult except that `refetch` returns a promise.
export type UseCachedResourceResult<T> = FetchState<T> & {
  /**
   * Force a fresh revalidation. Unlike the base `useFetchData` refetch, the
   * returned promise settles only after the fresh value is committed to the
   * shared cache (it never rejects — failures land in the hook's error state),
   * so post-mutation flows can `await refetch()` before clearing optimistic UI.
   */
  refetch: () => Promise<void>;
  mutate: FetchMutator<T>;
  /** True while a background revalidation is running over cached data. */
  isValidating: boolean;
};

const DEFAULT_STALE_TIME_MS = 30_000;

function isUpdaterFn<T>(value: T | ((prev: T) => T)): value is (prev: T) => T {
  return typeof value === "function";
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : String(value));
}

export function useCachedResource<T>(
  key: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: CachedResourceOptions,
): UseCachedResourceResult<T> {
  const staleTime = options?.staleTime ?? DEFAULT_STALE_TIME_MS;
  const enabled = options?.enabled ?? true;
  const persist = options?.persist ?? false;

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [error, setError] = useState<Error | null>(null);
  const [isValidating, setIsValidating] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const subscribeFn = useCallback(
    (onChange: () => void) => (key ? subscribe(key, onChange) : () => {}),
    [key],
  );
  const getSnapshot = useCallback(
    () => (key ? getCached<T>(key, persist) : undefined),
    [key, persist],
  );
  const cached = useSyncExternalStore(subscribeFn, getSnapshot, getSnapshot);

  // Run a shared revalidation. `force` issues a fresh request even when one is
  // in-flight (for explicit refetch); background runs de-dup onto it.
  const doRevalidate = useCallback(
    (force: boolean): Promise<void> => {
      if (!key) return Promise.resolve();
      setIsValidating(true);
      return revalidate<T>(
        key,
        () => fetcherRef.current(new AbortController().signal),
        persist,
        force,
      )
        .then(() => {
          if (mountedRef.current) setError(null);
        })
        .catch((err: unknown) => {
          if (mountedRef.current) setError(toError(err));
        })
        .finally(() => {
          if (mountedRef.current) setIsValidating(false);
        });
    },
    [key, persist],
  );

  // Mount / key-change revalidation honors staleTime: a value younger than
  // staleTime paints instantly with no network. refetch() always forces.
  useEffect(() => {
    if (!key || !enabled) return;
    const snapshot = getCached<T>(key, persist);
    const isFresh = snapshot && Date.now() - snapshot.updatedAt < staleTime;
    if (isFresh) return;
    void doRevalidate(false);
  }, [key, enabled, persist, staleTime, doRevalidate]);

  // Return the settled-after-commit promise: callers that `await refetch()`
  // (e.g. useViewCatalog's install flow clearing its optimistic "installing"
  // state) must not resume before the fresh value is actually in the cache —
  // a fire-and-forget void here made that await resolve immediately, so the
  // optimistic state was dropped while the list still showed stale data.
  const refetch = useCallback(() => doRevalidate(true), [doRevalidate]);

  const mutate = useCallback(
    (next: T | ((prev: T) => T)) => {
      if (!key) return;
      if (isUpdaterFn(next)) {
        const current = getCached<T>(key, persist);
        if (!current) {
          throw new Error(
            "useCachedResource: mutate(updaterFn) called without cached data.",
          );
        }
        setCached(key, next(current.data), persist);
        return;
      }
      setCached(key, next, persist);
    },
    [key, persist],
  );

  let state: FetchState<T>;
  if (cached) {
    state = { status: "success", data: cached.data };
  } else if (error) {
    state = { status: "error", error };
  } else {
    state = { status: "loading" };
  }

  return { ...state, refetch, mutate, isValidating };
}
