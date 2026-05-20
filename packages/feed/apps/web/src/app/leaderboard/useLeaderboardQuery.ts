"use client";

import type { LeaderboardMetric, LeaderboardScope } from "@feed/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  fetchLeaderboardData,
  type LeaderboardData,
} from "./fetchLeaderboardData";

// Leaderboard pages are cached on the server for a short TTL.
// Show stale data instantly, then revalidate in the background.
const STALE_TIME = 2 * 60 * 1000; // 2 min — matches server cache TTL
const GC_TIME = 10 * 60 * 1000; // 10 min — keep old pages in memory for instant back-nav
const REFETCH_INTERVAL = 2 * 60 * 1000; // 2 min background poll

const POSITION_STALE_TIME = 5 * 60 * 1000; // 5 min — avoid refetching rank on every page switch
const POSITION_GC_TIME = 15 * 60 * 1000; // 15 min

export function getLeaderboardQueryKey({
  metric,
  page,
  pageSize,
  scope,
  userId,
  authToken,
}: {
  metric: LeaderboardMetric;
  page: number;
  pageSize: number;
  scope: LeaderboardScope;
  userId?: string;
  authToken?: string | null;
}) {
  return [
    "leaderboard",
    metric,
    scope,
    page,
    pageSize,
    userId ?? null,
    Boolean(authToken),
  ] as const;
}

export function getLeaderboardPositionQueryKey({
  metric,
  scope,
  pageSize,
  userId,
  authToken,
}: {
  metric: LeaderboardMetric;
  scope: LeaderboardScope;
  pageSize: number;
  userId?: string;
  authToken?: string | null;
}) {
  return [
    "leaderboard-position",
    metric,
    scope,
    pageSize,
    userId ?? null,
    Boolean(authToken),
  ] as const;
}

/**
 * React Query hook for paginated leaderboard data.
 *
 * Provides client-side caching so that:
 * - Page 1 → 2 → 1 is instant on the return trip (cached)
 * - Scope or metric switches are instant on return (cached)
 * - Window focus triggers background revalidation
 * - Previous page data stays visible while loading the next page (placeholderData)
 */
export function useLeaderboardQuery({
  metric,
  page,
  pageSize,
  scope,
  userId,
  authToken,
}: {
  metric: LeaderboardMetric;
  page: number;
  pageSize: number;
  scope: LeaderboardScope;
  userId?: string;
  authToken?: string | null;
}) {
  return useQuery({
    queryKey: getLeaderboardQueryKey({
      metric,
      page,
      pageSize,
      scope,
      userId,
      authToken,
    }),
    queryFn: ({ signal }) =>
      fetchLeaderboardData({
        currentPage: page,
        pageSize,
        selectedMetric: metric,
        selectedScope: scope,
        userId,
        authToken,
        signal,
      }),
    staleTime: STALE_TIME,
    gcTime: GC_TIME,
    refetchInterval: REFETCH_INTERVAL,
    refetchOnWindowFocus: true,
    // Keep previous page data visible while loading the new page
    placeholderData: (previousData) => previousData,
  });
}

/**
 * Separate query for the authenticated user's leaderboard position.
 *
 * Cached independently from page data so that:
 * - "Jump to My Position" is instant (position is already known)
 * - Switching pages doesn't re-fetch the position
 * - Longer staleTime (5 min) avoids unnecessary refetches while browsing
 */
export function useMyLeaderboardPosition({
  metric,
  scope,
  pageSize,
  userId,
  authToken,
}: {
  metric: LeaderboardMetric;
  scope: LeaderboardScope;
  pageSize: number;
  userId?: string;
  authToken?: string | null;
}) {
  return useQuery({
    queryKey: getLeaderboardPositionQueryKey({
      metric,
      scope,
      pageSize,
      userId,
      authToken,
    }),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams({
        metric,
        type: scope,
        pageSize: String(pageSize),
      });
      const res = await fetch(`/api/leaderboard/me?${params.toString()}`, {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
        signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return (data.currentUser ?? null) as {
        rank: number;
        page: number;
        entry: LeaderboardData["leaderboard"][0];
      } | null;
    },
    enabled: !!userId && !!authToken,
    staleTime: POSITION_STALE_TIME,
    gcTime: POSITION_GC_TIME,
    refetchOnWindowFocus: true,
  });
}

/**
 * Prefetches the next leaderboard page in the background.
 * Call this in a useEffect after data loads — the next page will be
 * instant when the user clicks "Next".
 */
export function usePrefetchNextPage({
  metric,
  currentPage,
  totalPages,
  pageSize,
  scope,
  userId,
  authToken,
}: {
  metric: LeaderboardMetric;
  currentPage: number;
  totalPages: number | undefined;
  pageSize: number;
  scope: LeaderboardScope;
  userId?: string;
  authToken?: string | null;
}) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (totalPages === undefined) return;
    if (currentPage >= totalPages) return;

    const nextPage = currentPage + 1;
    queryClient.prefetchQuery({
      queryKey: getLeaderboardQueryKey({
        metric,
        page: nextPage,
        pageSize,
        scope,
        userId,
        authToken,
      }),
      queryFn: ({ signal }) =>
        fetchLeaderboardData({
          currentPage: nextPage,
          pageSize,
          selectedMetric: metric,
          selectedScope: scope,
          userId,
          authToken,
          signal,
        }),
      staleTime: STALE_TIME,
    });
  }, [
    currentPage,
    totalPages,
    metric,
    pageSize,
    scope,
    userId,
    authToken,
    queryClient,
  ]);
}
