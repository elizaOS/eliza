/**
 * Deduplicated data fetching hook that prevents duplicate API calls.
 *
 * Features:
 * - Deduplicates concurrent requests to the same endpoint
 * - Caches responses with configurable TTL
 * - Stale-while-revalidate behavior
 * - Tracks in-flight requests to prevent race conditions
 *
 * @example
 * ```ts
 * const { data, error, isLoading, refetch } = useDedupedFetch<MyType>(
 *   '/api/my-endpoint',
 *   { revalidateOnFocus: true, dedupingInterval: 2000 }
 * );
 * ```
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Global request cache and in-flight tracking
const requestCache = new Map<string, { data: unknown; timestamp: number; expiresAt: number }>();
const inFlightRequests = new Map<string, Promise<Response>>();

// Default configuration
const DEFAULT_DEDUPING_INTERVAL = 2000; // 2 seconds
const DEFAULT_CACHE_TTL = 30000; // 30 seconds
const DEFAULT_STALE_TTL = 60000; // 60 seconds (serve stale while revalidating)

/**
 * Configuration options for useDedupedFetch.
 */
interface UseDedupedFetchOptions {
  /** Deduplication window duration in milliseconds. */
  dedupingInterval?: number;
  /** Cache TTL for fresh data in milliseconds. */
  cacheTTL?: number;
  /** Maximum age for stale data while revalidating in milliseconds. */
  staleTTL?: number;
  /** Whether to revalidate when window regains focus. */
  revalidateOnFocus?: boolean;
  /** Whether to revalidate when network reconnects. */
  revalidateOnReconnect?: boolean;
  /** Skip the initial fetch for conditional fetching. */
  skip?: boolean;
  /** Fetch API options (headers, method, body, etc.). */
  fetchOptions?: RequestInit;
  /** Transform function applied to response data before caching. */
  transform?: <T>(data: T) => T;
}

/**
 * Return value from useDedupedFetch hook.
 */
interface UseDedupedFetchResult<T> {
  /** Cached or fetched data. */
  data: T | null;
  /** Error if fetch failed. */
  error: Error | null;
  /** Whether initial fetch is in progress. */
  isLoading: boolean;
  /** Whether background revalidation is in progress. */
  isValidating: boolean;
  /** Force a revalidation of the data. */
  refetch: () => Promise<void>;
  /** Optimistically update the cached data. */
  mutate: (data: T | ((prev: T | null) => T)) => void;
}

/**
 * Generates a cache key for a request based on URL and options.
 */
function getCacheKey(url: string, options?: RequestInit): string {
  const method = options?.method || "GET";
  const body = options?.body ? String(options.body) : "";
  return `${method}:${url}:${body}`;
}

/**
 * Deduplicated fetch hook with caching and request deduplication.
 *
 * @param url - The URL to fetch, or null to skip fetching.
 * @param options - Configuration options for caching and revalidation.
 * @returns Hook result with data, loading state, and control functions.
 */
export function useDedupedFetch<T>(
  url: string | null,
  options: UseDedupedFetchOptions = {},
): UseDedupedFetchResult<T> {
  const {
    dedupingInterval = DEFAULT_DEDUPING_INTERVAL,
    cacheTTL = DEFAULT_CACHE_TTL,
    staleTTL = DEFAULT_STALE_TTL,
    revalidateOnFocus = false,
    revalidateOnReconnect = false,
    skip = false,
    fetchOptions,
    transform,
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(!skip && !!url);
  const [isValidating, setIsValidating] = useState(false);

  // Use refs to avoid stale closures
  const mountedRef = useRef(true);
  const lastFetchRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Memoize the cache key
  const cacheKey = useMemo(
    () => (url ? getCacheKey(url, fetchOptions) : null),
    [url, fetchOptions],
  );

  // Fetch function
  const fetchData = useCallback(
    async (forceRevalidate = false) => {
      if (!url || !cacheKey || skip) return;

      const now = Date.now();

      // Check if we should dedupe this request
      if (!forceRevalidate && now - lastFetchRef.current < dedupingInterval) {
        console.debug(`[useDedupedFetch] Deduping request to ${url}`);
        return;
      }

      // Check cache
      const cached = requestCache.get(cacheKey);
      if (cached) {
        const isFresh = now < cached.expiresAt;
        const isStale = now < cached.timestamp + staleTTL;

        if (isFresh && !forceRevalidate) {
          // Cache hit - return cached data
          setData(cached.data as T);
          setIsLoading(false);
          setError(null);
          return;
        }

        if (isStale && !forceRevalidate) {
          // Stale-while-revalidate - return stale data but revalidate in background
          setData(cached.data as T);
          setIsLoading(false);
          setIsValidating(true);
        }
      }

      // Check for in-flight request (deduplication)
      const inFlight = inFlightRequests.get(cacheKey);
      if (inFlight && !forceRevalidate) {
        console.debug(`[useDedupedFetch] Joining in-flight request to ${url}`);
        try {
          const response = await inFlight;
          const responseData = await response.clone().json();
          const transformedData = transform ? transform(responseData) : responseData;

          if (mountedRef.current) {
            setData(transformedData as T);
            setIsLoading(false);
            setIsValidating(false);
            setError(null);
          }
        } catch (err) {
          if (mountedRef.current) {
            setError(err instanceof Error ? err : new Error(String(err)));
            setIsLoading(false);
            setIsValidating(false);
          }
        }
        return;
      }

      // Cancel any previous request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      // Create new abort controller
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      // Track this request
      lastFetchRef.current = now;

      if (!data) {
        setIsLoading(true);
      }
      setIsValidating(true);

      try {
        // Create the fetch promise and store it for deduplication
        const fetchPromise = fetch(url, {
          ...fetchOptions,
          signal: abortController.signal,
        });

        inFlightRequests.set(cacheKey, fetchPromise);

        const response = await fetchPromise;

        // Remove from in-flight after response received
        inFlightRequests.delete(cacheKey);

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const responseData = await response.json();
        const transformedData = transform ? transform(responseData) : responseData;

        // Update cache
        requestCache.set(cacheKey, {
          data: transformedData,
          timestamp: now,
          expiresAt: now + cacheTTL,
        });

        if (mountedRef.current) {
          setData(transformedData as T);
          setError(null);
          setIsLoading(false);
          setIsValidating(false);
        }
      } catch (err) {
        // Remove from in-flight on error
        inFlightRequests.delete(cacheKey);
        if (mountedRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setIsLoading(false);
          setIsValidating(false);
        }
        throw err;
      }
    },
    [url, cacheKey, skip, dedupingInterval, cacheTTL, staleTTL, fetchOptions, transform, data],
  );

  // Refetch function (forces revalidation)
  const refetch = useCallback(async () => {
    await fetchData(true);
  }, [fetchData]);

  // Mutate function (optimistic updates)
  const mutate = useCallback(
    (newData: T | ((prev: T | null) => T)) => {
      const resolvedData =
        typeof newData === "function" ? (newData as (prev: T | null) => T)(data) : newData;

      setData(resolvedData);

      // Update cache
      if (cacheKey) {
        const now = Date.now();
        requestCache.set(cacheKey, {
          data: resolvedData,
          timestamp: now,
          expiresAt: now + cacheTTL,
        });
      }
    },
    [data, cacheKey, cacheTTL],
  );

  // Initial fetch
  useEffect(() => {
    // Defer initial fetch to avoid cascading renders
    queueMicrotask(() => {
      fetchData();
    });

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchData]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Revalidate on focus
  useEffect(() => {
    if (!revalidateOnFocus) return;

    const handleFocus = () => {
      fetchData();
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [revalidateOnFocus, fetchData]);

  // Revalidate on reconnect
  useEffect(() => {
    if (!revalidateOnReconnect) return;

    const handleOnline = () => {
      fetchData(true);
    };

    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [revalidateOnReconnect, fetchData]);

  return {
    data,
    error,
    isLoading,
    isValidating,
    refetch,
    mutate,
  };
}

/**
 * Clears the entire request cache.
 */
export function clearFetchCache(): void {
  requestCache.clear();
}

/**
 * Invalidates a specific cache entry by URL and options.
 *
 * @param url - The URL to invalidate.
 * @param options - Optional fetch options used to generate cache key.
 */
export function invalidateFetchCache(url: string, options?: RequestInit): void {
  const cacheKey = getCacheKey(url, options);
  requestCache.delete(cacheKey);
}

/**
 * Prefetches a URL and caches the result.
 *
 * @param url - The URL to prefetch.
 * @param options - Optional fetch options.
 * @param cacheTTL - Cache TTL in milliseconds.
 * @returns The fetched data.
 */
export async function prefetch<T>(
  url: string,
  options?: RequestInit,
  cacheTTL = DEFAULT_CACHE_TTL,
): Promise<T> {
  const cacheKey = getCacheKey(url, options);

  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  const now = Date.now();

  requestCache.set(cacheKey, {
    data,
    timestamp: now,
    expiresAt: now + cacheTTL,
  });

  return data as T;
}
