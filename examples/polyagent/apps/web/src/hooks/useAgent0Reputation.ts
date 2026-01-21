"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Agent0 profile data structure
 */
interface Agent0Profile {
  tokenId: number;
  name: string;
  walletAddress: string;
  active: boolean;
  reputation?: {
    trustScore: number;
    accuracyScore: number;
    totalBets: number;
    winningBets: number;
  };
}

/**
 * Agent0 reputation summary
 */
interface Agent0ReputationSummary {
  count: number;
  averageScore: number;
}

/**
 * Hook return type
 */
interface UseAgent0ReputationReturn {
  profile: Agent0Profile | null;
  reputation: Agent0ReputationSummary | null;
  loading: boolean;
  error: Error | null;
  isAgent0Available: boolean;
  refetch: () => Promise<void>;
}

/**
 * Hook to fetch Agent0 network reputation data for an agent
 *
 * @param agentId - The agent's database ID (used to lookup Agent0 tokenId)
 * @returns Agent0 profile, reputation summary, loading state, and availability
 */
export function useAgent0Reputation(
  agentId?: string,
): UseAgent0ReputationReturn {
  const [profile, setProfile] = useState<Agent0Profile | null>(null);
  const [reputation, setReputation] = useState<Agent0ReputationSummary | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [isAgent0Available, setIsAgent0Available] = useState(false);

  const fetchReputation = useCallback(async () => {
    if (!agentId) {
      setProfile(null);
      setReputation(null);
      setIsAgent0Available(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Fetch agent details which includes Agent0 registration info
      const response = await fetch(`/api/agents/${agentId}`);

      if (!response.ok) {
        if (response.status === 404) {
          setIsAgent0Available(false);
          setProfile(null);
          setReputation(null);
          return;
        }
        throw new Error(`Failed to fetch agent: ${response.statusText}`);
      }

      const data = await response.json();
      const agent = data.agent;

      // Check if agent has Agent0 registration
      if (!agent?.agent0TokenId) {
        setIsAgent0Available(false);
        setProfile(null);
        setReputation(null);
        return;
      }

      setIsAgent0Available(true);

      // Build profile from agent data
      const agent0Profile: Agent0Profile = {
        tokenId: agent.agent0TokenId,
        name: agent.name,
        walletAddress: agent.walletAddress ?? "",
        active: agent.isActive ?? false,
        reputation: agent.reputation
          ? {
              trustScore: agent.reputation.trustScore ?? 0,
              accuracyScore: agent.reputation.accuracyScore ?? 0,
              totalBets: agent.reputation.totalBets ?? 0,
              winningBets: agent.reputation.winningBets ?? 0,
            }
          : undefined,
      };

      setProfile(agent0Profile);

      // Fetch reputation summary if available
      if (agent.reputation?.feedbackCount !== undefined) {
        setReputation({
          count: agent.reputation.feedbackCount,
          averageScore: agent.reputation.averageScore ?? 0,
        });
      } else {
        setReputation(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Unknown error"));
      setIsAgent0Available(false);
      setProfile(null);
      setReputation(null);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    fetchReputation();
  }, [fetchReputation]);

  return {
    profile,
    reputation,
    loading,
    error,
    isAgent0Available,
    refetch: fetchReputation,
  };
}
