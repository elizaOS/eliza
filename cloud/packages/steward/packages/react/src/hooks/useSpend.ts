import { useCallback, useEffect, useState } from "react";
import { useStewardContext } from "../provider.js";
import type { SpendStats } from "../types.js";

/**
 * Spend analytics for a given time range.
 */
export function useSpend(range: "24h" | "7d" | "30d" | "all" = "7d") {
  const { client, agentId, pollInterval } = useStewardContext();
  const [stats, setStats] = useState<SpendStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const baseUrl = client.getBaseUrl();

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(
        `${baseUrl}/agents/${encodeURIComponent(agentId)}/spend-stats?range=${range}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.ok) {
        const json = await res.json();
        if (json.ok && json.data) {
          setStats(json.data);
        }
      }
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl, agentId, range]);

  useEffect(() => {
    fetchStats();
    const interval = setInterval(fetchStats, pollInterval);
    return () => clearInterval(interval);
  }, [fetchStats, pollInterval]);

  return {
    stats,
    isLoading,
    error,
    refetch: fetchStats,
  };
}
