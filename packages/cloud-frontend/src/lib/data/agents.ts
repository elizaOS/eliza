import { useQuery } from "@tanstack/react-query";
import { api } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

/**
 * A character row from `GET /api/my-agents/characters`. Fields mirror the
 * server projection in `packages/cloud-api/my-agents/characters/route.ts`.
 * Both camelCase and snake_case aliases are returned by the API.
 */
export interface MyAgentCharacter {
  id: string;
  name: string;
  bio: string | string[] | null;
  avatarUrl: string | null;
  avatar_url: string | null;
  category: string | null;
  isPublic: boolean;
  is_public: boolean;
  createdAt: string | null;
  created_at: string | null;
  updatedAt: string | null;
  updated_at: string | null;
  tags: string[] | null;
  token_address: string | null;
  token_chain: string | null;
  token_name: string | null;
  token_ticker: string | null;
}

interface AgentsListResponse {
  success: boolean;
  data: {
    characters: MyAgentCharacter[];
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
