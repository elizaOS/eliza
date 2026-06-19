/**
 * Documents-domain data hook: the caller's characters (= the per-character
 * scope selector for knowledge/documents).
 *
 * Ported from `@elizaos/cloud-frontend/src/lib/data/agents.ts`, rewired to the
 * shared cloud `api<T>` client. Only the fields the documents view consumes are
 * narrowed off the projection (`GET /api/my-agents/characters`).
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

/**
 * A character row from `GET /api/my-agents/characters`. Fields mirror the
 * server projection in `packages/cloud-api/my-agents/characters/route.ts`.
 */
export interface MyAgentCharacter {
  id: string;
  name: string;
  bio: string | string[] | null;
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
 * `GET /api/my-agents/characters` — the caller's characters, used as the
 * per-character scope selector for documents/knowledge.
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
