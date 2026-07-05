/**
 * React-query hooks for the hosted Eliza agents (Instances) list + detail.
 */

import type {
  AgentListItemDto,
  AgentResponse,
  AgentsResponse,
} from "@elizaos/cloud-shared/lib/types/cloud-api";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api-client";
import {
  authenticatedQueryKey,
  useAuthenticatedQueryGate,
} from "../../../lib/auth-query";

export type AgentListItem = AgentListItemDto;

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
    refetchInterval: gate.enabled ? 15_000 : false,
    // Keep polling while the tab is backgrounded so the list converges even when
    // hidden. The agents table hides a just-deleted row for a 60s grace before
    // re-checking; if this interval paused while backgrounded, a delete + long
    // background could freeze the list stale and briefly resurrect the deleted
    // row on refocus. Cheap authenticated GET; precedent: payment-waiting-overlay.
    refetchIntervalInBackground: true,
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
