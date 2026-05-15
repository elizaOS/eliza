import { useQuery } from "@tanstack/react-query";
import type {
  AgentDetailDto,
  AgentListItemDto,
  AgentResponse,
  AgentsResponse,
} from "@/lib/types/cloud-api";
import { api } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

export type AgentListItem = AgentListItemDto;
export type AgentDetail = AgentDetailDto;

/** GET /api/v1/eliza/agents — list of Eliza agents in the org. */
export function useAgents() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["agent", "agents"], gate),
    queryFn: async () => {
      const res = await api<AgentsResponse>("/api/v1/eliza/agents");
      return res.data;
    },
    enabled: gate.enabled,
  });
}

/** GET /api/v1/eliza/agents/[agentId] — single agent detail. */
export function useAgent(agentId: string | undefined) {
  const gate = useAuthenticatedQueryGate(Boolean(agentId));
  return useQuery({
    queryKey: authenticatedQueryKey(["agent", "agent", agentId], gate),
    queryFn: async () => {
      const res = await api<AgentResponse>(`/api/v1/eliza/agents/${agentId}`);
      return res.data;
    },
    enabled: gate.enabled,
  });
}
