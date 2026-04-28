import { QueryClient } from "@tanstack/react-query";

const defaultOptions = {
  queries: {
    staleTime: 60 * 1000, // 1 minute
    gcTime: 5 * 60 * 1000, // 5 minutes (formerly cacheTime)
    retry: 1,
    refetchOnWindowFocus: false,
  },
  mutations: {
    retry: 0,
  },
};

export function createQueryClient() {
  return new QueryClient({
    defaultOptions,
  });
}
