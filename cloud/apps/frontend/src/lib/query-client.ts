import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api-client";

/**
 * Single QueryClient for the SPA. Defaults match the dashboard's read-mostly
 * pattern: 30s stale time, retry on transient errors only, refetch on window
 * focus disabled so navigation doesn't hammer the API.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      retry: (failureCount, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});
