/**
 * React-query hooks for the hosted Eliza agents (Instances) list + detail.
 */

import type {
  AgentListItemDto,
  AgentSandboxStatus,
} from "@elizaos/cloud-shared/lib/types/cloud-api";
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
export const AGENTS_QUERY_KEY = ["agent", "agents"] as const;

const ACTIVE_AGENT_STATUSES: ReadonlySet<AgentSandboxStatus> = new Set([
  "pending",
  "provisioning",
]);

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
    queryKey: authenticatedQueryKey(AGENTS_QUERY_KEY, gate),
    queryFn: fetchAgents,
    enabled: gate.enabled,
    // One validated query owns both rows and their hosting summary. Active
    // lifecycle states converge faster, while settled lists retain the prior
    // cadence and React Query's retry backoff on transport failures.
    refetchInterval: (query) => {
      if (!gate.enabled) return false;
      if (query.state.data === undefined) return 15_000;
      return query.state.data.agents.some((agent) =>
        ACTIVE_AGENT_STATUSES.has(agent.status),
      )
        ? 10_000
        : 15_000;
    },
    // Background polling keeps lifecycle transitions convergent even when the
    // tab is hidden.
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
