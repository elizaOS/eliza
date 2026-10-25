/**
 * React Query hook for the authenticated user's API keys. Calls the shared
 * cloud `api<T>` client (`/api/v1/api-keys`) and gates on the Steward session
 * via {@link useAuthenticatedQueryGate}. Mutations on the keys page
 * invalidate the `["api-keys"]` query key directly, so a long stale window is
 * safe.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api-client";
import {
  authenticatedQueryKey,
  useAuthenticatedQueryGate,
} from "../lib/auth-query";

/** Server shape of a single API key as returned by `GET /api/v1/api-keys`. */
export interface ApiKeyRecord {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  usage_count: number;
  rate_limit: number;
  expires_at: string | null;
}

/**
 * Plan-limited count of user-created keys (#22958). Keys are free; the plan
 * caps how many a user can create (pay-as-you-go 5, Plus 10, Pro 25).
 */
export type ApiKeyUsage =
  | { status: "available"; used: number; limit: number; remaining: number }
  | { status: "unavailable"; code: string };

/** Server shape of `GET /api/v1/api-keys`. */
export interface ApiKeysResponse {
  keys: ApiKeyRecord[];
  usage: ApiKeyUsage;
}

// API keys change only on explicit user action. Mutations invalidate this key
// directly, so a 5-minute stale window is safe and avoids refetching the list
// every time the user pops back to the keys surface.
const API_KEY_STALE_MS = 5 * 60 * 1000;

export const API_KEYS_QUERY_KEY = ["api-keys"] as const;

export function useApiKeys() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(API_KEYS_QUERY_KEY, gate),
    queryFn: () => api<ApiKeysResponse>("/api/v1/api-keys"),
    enabled: gate.enabled,
    staleTime: API_KEY_STALE_MS,
  });
}
