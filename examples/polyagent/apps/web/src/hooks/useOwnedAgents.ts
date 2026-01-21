"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "./useAuth";

/**
 * Agent data structure for owned agents.
 * Contains the essential fields needed for the AgentChat component.
 */
export interface OwnedAgentData {
  id: string;
  name: string;
  profileImageUrl?: string;
  virtualBalance: number;
  modelTier: "free" | "pro";
  status: string;
  autonomousEnabled: boolean;
}

interface UseOwnedAgentsReturn {
  /** Map of agent IDs to their data */
  agents: Map<string, OwnedAgentData>;
  /** Whether the agents are currently being loaded */
  loading: boolean;
  /** Error message if loading failed */
  error: string | null;
  /** Check if a user ID is one of the current user's agents */
  isOwnAgent: (userId: string) => boolean;
  /** Get agent data by ID (returns undefined if not an owned agent) */
  getAgentData: (userId: string) => OwnedAgentData | undefined;
  /** Refresh the agents list */
  refresh: () => Promise<void>;
  /** Update the balance for a specific agent */
  updateAgentBalance: (agentId: string, newBalance: number) => void;
}

/**
 * Hook to manage the current user's owned AI agents.
 *
 * Fetches and caches the list of agents owned by the authenticated user.
 * Provides utilities to check if a given user ID is an owned agent and
 * to retrieve agent data for rendering the AgentChat component.
 *
 * @returns Object containing agent data and utility functions
 *
 * @example
 * ```tsx
 * const { isOwnAgent, getAgentData } = useOwnedAgents();
 *
 * // Check if chatting with own agent
 * if (isOwnAgent(otherUserId)) {
 *   const agentData = getAgentData(otherUserId);
 *   return <AgentChat agent={agentData} />;
 * }
 * ```
 */
export function useOwnedAgents(): UseOwnedAgentsReturn {
  const { authenticated, getAccessToken, user } = useAuth();
  const [agents, setAgents] = useState<Map<string, OwnedAgentData>>(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAgents = useCallback(async () => {
    if (!authenticated || !user) {
      setAgents(new Map());
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const token = await getAccessToken();
      if (!token) {
        setError("Authentication required");
        setLoading(false);
        return;
      }

      const response = await fetch("/api/agents", {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error("Failed to fetch agents");
      }

      const data = await response.json();
      const agentsList = data.agents || [];

      // Build a map of agent ID to agent data
      const agentsMap = new Map<string, OwnedAgentData>();
      for (const agent of agentsList) {
        agentsMap.set(agent.id, {
          id: agent.id,
          name: agent.name || agent.username || "Agent",
          profileImageUrl: agent.profileImageUrl,
          virtualBalance: Number(agent.virtualBalance ?? 0),
          modelTier: agent.modelTier === "pro" ? "pro" : "free",
          status: agent.status || "idle",
          autonomousEnabled: Boolean(agent.autonomousEnabled),
        });
      }

      setAgents(agentsMap);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [authenticated, getAccessToken, user]);

  // Fetch agents when authenticated
  useEffect(() => {
    if (authenticated && user) {
      fetchAgents();
    } else {
      setAgents(new Map());
    }
  }, [authenticated, user, fetchAgents]);

  const isOwnAgent = useCallback(
    (userId: string): boolean => {
      return agents.has(userId);
    },
    [agents],
  );

  const getAgentData = useCallback(
    (userId: string): OwnedAgentData | undefined => {
      return agents.get(userId);
    },
    [agents],
  );

  const updateAgentBalance = useCallback(
    (agentId: string, newBalance: number) => {
      setAgents((prev) => {
        const agent = prev.get(agentId);
        if (!agent) return prev;

        const updated = new Map(prev);
        updated.set(agentId, {
          ...agent,
          virtualBalance: newBalance,
        });
        return updated;
      });
    },
    [],
  );

  return useMemo(
    () => ({
      agents,
      loading,
      error,
      isOwnAgent,
      getAgentData,
      refresh: fetchAgents,
      updateAgentBalance,
    }),
    [
      agents,
      loading,
      error,
      isOwnAgent,
      getAgentData,
      fetchAgents,
      updateAgentBalance,
    ],
  );
}
