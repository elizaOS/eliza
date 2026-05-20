'use client';

import { logger } from '@feed/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { TeamDashboardAgent } from '@/lib/agents/team-dashboard-types';
import type { TeamTradingSummary } from '@/lib/agents/team-trading-summary';

interface TeamDashboardResponse {
  success: boolean;
  agents: TeamDashboardAgent[];
  summary: TeamTradingSummary;
}

export function useAgentsTeamDashboard({
  enabled,
  getAccessToken,
}: {
  enabled: boolean;
  getAccessToken: () => Promise<string | null>;
}): {
  agents: TeamDashboardAgent[];
  agentStatsMap: Map<string, TeamDashboardAgent>;
  summary: TeamTradingSummary | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [agents, setAgents] = useState<TeamDashboardAgent[]>([]);
  const [summary, setSummary] = useState<TeamTradingSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const refresh = useCallback(() => {
    setRefreshNonce((value) => value + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshNonce intentionally forces a refetch
  useEffect(() => {
    if (!enabled) {
      setAgents([]);
      setSummary(null);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    const abort = new AbortController();

    const run = async () => {
      setLoading(true);
      setError(null);

      try {
        const token = await getAccessToken();
        if (!token) {
          throw new Error('Authentication required');
        }

        const response = await fetch('/api/agents/team-dashboard', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: abort.signal,
        });

        if (!response.ok) {
          throw new Error(
            `Failed to fetch team dashboard (${response.status})`
          );
        }

        const data = (await response.json()) as TeamDashboardResponse;
        if (!data.success) {
          throw new Error('Failed to fetch team dashboard');
        }

        if (cancelled) {
          return;
        }

        setAgents(data.agents);
        setSummary(data.summary);
      } catch (err) {
        if (cancelled) {
          return;
        }

        const message =
          err instanceof Error ? err.message : 'Failed to load team dashboard';
        setError(message);
        setAgents([]);
        setSummary(null);
        logger.error(
          'Failed to fetch agents team dashboard',
          { error: message },
          'useAgentsTeamDashboard'
        );
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      cancelled = true;
      abort.abort();
    };
  }, [enabled, getAccessToken, refreshNonce]);

  const agentStatsMap = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent])),
    [agents]
  );

  return {
    agents,
    agentStatsMap,
    summary,
    loading,
    error,
    refresh,
  };
}
