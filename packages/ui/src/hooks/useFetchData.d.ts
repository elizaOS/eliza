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
export type FetchState<T> =
  | {
      status: "idle";
    }
  | {
      status: "loading";
    }
  | {
      status: "success";
      data: T;
    }
  | {
      status: "error";
      error: Error;
    };
export type FetchMutator<T> = {
  (next: T): void;
  (updater: (prev: T) => T): void;
};
export type UseFetchDataResult<T> = FetchState<T> & {
  refetch: () => void;
  mutate: FetchMutator<T>;
};
export declare function useFetchData<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: ReadonlyArray<unknown>,
): UseFetchDataResult<T>;
//# sourceMappingURL=useFetchData.d.ts.map
