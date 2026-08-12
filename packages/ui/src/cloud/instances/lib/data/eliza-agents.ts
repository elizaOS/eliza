/**
 * React-query hooks for the hosted Eliza agents (Instances) list + detail.
 */

import type { AgentListItemDto } from "@elizaos/cloud-shared/lib/types/cloud-api";
import {
  agentResponseSchema,
  agentsResponseSchema,
} from "@elizaos/cloud-shared/types/agent-api-schema";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../../lib/api-client";
import {
  authenticatedQueryKey,
  useAuthenticatedQueryGate,
} from "../../../lib/auth-query";

export type AgentListItem = AgentListItemDto;

export async function fetchAgents() {
  const res = agentsResponseSchema.parse(
    await api<unknown>("/api/v1/eliza/agents"),
  );
  return { agents: res.data, hostingSummary: res.hostingSummary };
}

export async function fetchAgent(agentId: string) {
  const res = agentResponseSchema.parse(
    await api<unknown>(`/api/v1/eliza/agents/${agentId}`),
  );
  return res.data;
}

/** GET /api/v1/eliza/agents — list of Eliza agents in the org. */
export function useAgents() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["agent", "agents"], gate),
    queryFn: fetchAgents,
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
    queryFn: () => {
      if (!agentId) throw new Error("Agent id is required");
      return fetchAgent(agentId);
    },
    enabled: gate.enabled,
  });
}
