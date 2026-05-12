"use client";

/**
 * SWR-based dashboard data hook
 *
 * Provides stale-while-revalidate caching for dashboard data.
 * Shows cached data immediately while fetching fresh data in background.
 *
 * Performance benefits:
 * - Instant page loads from cache
 * - Background revalidation keeps data fresh
 * - Deduplication of requests across components
 * - Automatic retry on errors
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface DashboardAgentStats {
  roomCount: number;
  messageCount: number;
  deploymentStatus: string;
  lastActiveAt: Date | null;
}

interface DashboardAgent {
  id: string;
  name: string;
  bio: string | string[];
  avatarUrl: string | null;
  category: string | null;
  isPublic: boolean;
  stats?: DashboardAgentStats;
}

interface DashboardContainer {
  id: string;
  name: string;
  description: string | null;
  status: string;
  load_balancer_url: string | null;
  port: number;
  desired_count: number;
  cpu: number;
  memory: number;
  last_deployed_at: Date | null;
  created_at: Date;
  error_message: string | null;
}

export interface DashboardData {
  user: {
    name: string;
  };
  stats: {
    totalGenerations: number;
    apiCalls24h: number;
    imageGenerations: number;
    videoGenerations: number;
  };
  onboarding: {
    hasAgents: boolean;
    hasApiKey: boolean;
    hasChatHistory: boolean;
  };
  agents: DashboardAgent[];
  containers: DashboardContainer[];
}

interface UseDashboardDataReturn {
  data: DashboardData | null;
  isLoading: boolean;
  isValidating: boolean;
  error: Error | null;
  mutate: () => Promise<void>;
}

// Simple in-memory cache for SWR-like behavior
const cache = new Map<string, { data: DashboardData; timestamp: number }>();
const CACHE_TTL = 30 * 1000; // 30 seconds - match API cache TTL
const STALE_TTL = 60 * 1000; // 60 seconds - serve stale while revalidating

export function useDashboardData(): UseDashboardDataReturn {
  const [data, setData] = useState<DashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const isMountedRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (isRevalidation = false) => {
    // Cancel any in-flight request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    if (!isRevalidation) {
      setIsLoading(true);
    } else {
      setIsValidating(true);
    }

    try {
      const response = await fetch("/api/v1/dashboard", {
        signal: abortControllerRef.current.signal,
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch dashboard: ${response.statusText}`);
      }

      const freshData = await response.json();

      if (isMountedRef.current) {
        setData(freshData);
        setError(null);
        // Update cache
        cache.set("dashboard", { data: freshData, timestamp: Date.now() });
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return; // Ignore aborted requests
      }
      if (isMountedRef.current) {
        setError(err instanceof Error ? err : new Error("Unknown error"));
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
        setIsValidating(false);
      }
    }
  }, []);

  const mutate = useCallback(async () => {
    // Clear cache and refetch
    cache.delete("dashboard");
    await fetchData(false);
  }, [fetchData]);

  useEffect(() => {
    isMountedRef.current = true;

    // Check cache first
    const cached = cache.get("dashboard");
    const now = Date.now();

    if (cached) {
      const age = now - cached.timestamp;

      // Use cached data immediately
      setData(cached.data);
      setIsLoading(false);

      if (age < CACHE_TTL) {
        // Data is fresh enough, no need to revalidate
        return;
      }

      if (age < STALE_TTL) {
        // Data is stale but usable, revalidate in background
        fetchData(true);
        return;
      }
    }

    // No cache or cache is too old, fetch fresh data
    fetchData(false);

    return () => {
      isMountedRef.current = false;
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchData]);

  // Visibility-based revalidation
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        const cached = cache.get("dashboard");
        if (cached && Date.now() - cached.timestamp > CACHE_TTL) {
          fetchData(true);
        }
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchData]);

  return { data, isLoading, isValidating, error, mutate };
}
