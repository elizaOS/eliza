import type { Agent, UUID } from '@elizaos/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStartAgent, useStopAgent } from './use-query-hooks';
import { useToast } from './use-toast';
import clientLogger from '@/lib/logger';

/**
 * Custom hook for managing agents (starting, stopping, and tracking status)
 */
/**
 * Custom hook for agent management.
 * Allows starting and stopping agents with mutation operations.
 * Provides functions to check if an agent is currently starting or stopping.
 * @returns Object with functions for starting and stopping agents, checking agent status, and lists of agents in starting and stopping processes.
 */
export function useAgentManagement() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // Mutations for starting and stopping agents
  const startAgentMutation = useStartAgent();
  const stopAgentMutation = useStopAgent();

  // Track agents that are currently in the process of starting or stopping
  const [startingAgents, setStartingAgents] = useState<UUID[]>([]);
  const [stoppingAgents, setStoppingAgents] = useState<UUID[]>([]);

  /**
   * Start an agent and navigate to its chat
   */
  const startAgent = async (agent: Agent) => {
    if (!agent.id) {
      toast({
        title: 'Error',
        description: 'Agent ID is missing',
        variant: 'destructive',
      });
      return;
    }

    const agentId = agent.id as UUID;

    // Prevent starting if already in progress
    if (startingAgents.includes(agentId)) {
      return;
    }

    try {
      // Add agent to starting list
      setStartingAgents((prev) => [...prev, agentId]);

      // Start the agent
      await startAgentMutation.mutateAsync(agentId);
    } catch (error) {
      clientLogger.error('Failed to start agent:', error);
      // Let the mutation's onError handler show the appropriate toast
    } finally {
      // Remove agent from starting list regardless of success/failure
      setStartingAgents((prev) => prev.filter((id) => id !== agentId));
    }
  };

  /**
   * Stop an agent
   */
  const stopAgent = async (agent: Agent) => {
    if (!agent.id) {
      toast({
        title: 'Error',
        description: 'Agent ID is missing',
        variant: 'destructive',
      });
      return;
    }

    const agentId = agent.id as UUID;

    // Prevent stopping if already in progress
    if (stoppingAgents.includes(agentId)) {
      return;
    }

    try {
      // Add agent to stopping list
      setStoppingAgents((prev) => [...prev, agentId]);

      // Stop the agent
      await stopAgentMutation.mutateAsync(agentId);

      toast({
        title: 'Agent Stopped',
        description: `${agent.name} has been stopped`,
      });
    } catch (error) {
      clientLogger.error('Failed to stop agent:', error);
      // Let the mutation's onError handler show the appropriate toast
    } finally {
      // Remove agent from stopping list regardless of success/failure
      setStoppingAgents((prev) => prev.filter((id) => id !== agentId));
    }
  };

  /**
   * Check if an agent is currently starting
   */
  const isAgentStarting = (agentId: UUID | undefined | null) => {
    if (!agentId) return false;
    return startingAgents.includes(agentId);
  };

  /**
   * Check if an agent is currently stopping
   */
  const isAgentStopping = (agentId: UUID | undefined | null) => {
    if (!agentId) return false;
    return stoppingAgents.includes(agentId);
  };

  return {
    startAgent,
    stopAgent,
    isAgentStarting,
    isAgentStopping,
    startingAgents,
    stoppingAgents,
  };
}
