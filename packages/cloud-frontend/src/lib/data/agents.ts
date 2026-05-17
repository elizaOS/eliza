import { useQuery } from "@tanstack/react-query";
import { api } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

interface Agent {
  id: string;
  name: string;
  status?: string;
  [key: string]: unknown;
}

interface AgentsListResponse {
  success: boolean;
  data: {
    characters: Agent[];
    pagination: {
      page: number;
      limit: number;
      totalPages: number;
      totalCount: number;
      hasMore: boolean;
    };
  };
}

/**
 * GET /api/my-agents/characters — returns the caller's characters and
 * pagination metadata.
 */
export function useMyAgents() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["my-agents", "characters"], gate),
    queryFn: async () => {
      const data = await api<AgentsListResponse>("/api/my-agents/characters");
      return data.data.characters;
    },
    enabled: gate.enabled,
  });
}
