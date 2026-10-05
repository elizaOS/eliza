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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  getCached,
  getRevalidationError,
  revalidate,
  setCached,
  subscribe,
} from "./resource-cache";
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
  /** Most recent revalidation failure, also available while showing stale data. */
  revalidationError: Error | null;
};

const DEFAULT_STALE_TIME_MS = 30_000;

function isUpdaterFn<T>(value: T | ((prev: T) => T)): value is (prev: T) => T {
  return typeof value === "function";
}

export function useCachedResource<T>(
  requestedKey: string | null,
  fetcher: (signal: AbortSignal) => Promise<T>,
  options?: CachedResourceOptions,
): UseCachedResourceResult<T> {
  const staleTime = options?.staleTime ?? DEFAULT_STALE_TIME_MS;
  const enabled = options?.enabled ?? true;
  const persist = options?.persist ?? false;
  const key = enabled ? requestedKey : null;
  const scope = useMemo(() => ({ key, persist }), [key, persist]);
  const currentScope = useRef(scope);
  const requestId = useRef(0);

  const fetcherRef = useRef(fetcher);
  useLayoutEffect(() => {
    currentScope.current = scope;
    fetcherRef.current = fetcher;
  }, [scope, fetcher]);

  const [validation, setValidation] = useState<{
    scope: object;
    pending: boolean;
  }>({ scope, pending: false });
  const isValidating = validation.scope === scope && validation.pending;

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
  const getErrorSnapshot = useCallback(
    () => (key ? getRevalidationError(key) : null),
    [key],
  );
  const error = useSyncExternalStore(
    subscribeFn,
    getErrorSnapshot,
    getErrorSnapshot,
  );

  // Run a shared revalidation. `force` issues a fresh request even when one is
  // in-flight (for explicit refetch); background runs de-dup onto it.
  const doRevalidate = useCallback(
    (force: boolean): Promise<void> => {
      if (!key) return Promise.resolve();
      const id = ++requestId.current;
      const isCurrent = () =>
        mountedRef.current &&
        currentScope.current === scope &&
        requestId.current === id;
      setValidation({ scope, pending: true });
      const settle = () => {
        if (isCurrent()) setValidation({ scope, pending: false });
      };
      return revalidate<T>(
        key,
        () => fetcherRef.current(new AbortController().signal),
        persist,
        force,
      ).then(settle, settle);
    },
    [key, persist, scope],
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

  return { ...state, refetch, mutate, isValidating, revalidationError: error };
}
