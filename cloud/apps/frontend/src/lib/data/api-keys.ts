import { useQuery } from "@tanstack/react-query";
import { api } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

export interface ApiKeyRecord {
  id: string;
  name: string;
  description: string | null;
  key_prefix: string;
  is_active: boolean;
  last_used_at: string | null;
  created_at: string;
  permissions: string[];
  usage_count: number;
  rate_limit: number;
  expires_at: string | null;
}

// API keys change only on explicit user action. Mutations invalidate this key
// directly, so a 5-minute stale window is safe and avoids refetching the list
// every time the user pops back to the keys page.
const API_KEY_STALE_MS = 5 * 60 * 1000;

export function useApiKeys() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["api-keys"], gate),
    queryFn: async () => {
      const data = await api<{ keys: ApiKeyRecord[] }>("/api/v1/api-keys");
      return data.keys;
    },
    enabled: gate.enabled,
    staleTime: API_KEY_STALE_MS,
  });
}

export function useApiKey(id: string | undefined) {
  const gate = useAuthenticatedQueryGate(Boolean(id));
  return useQuery({
    queryKey: authenticatedQueryKey(["api-key", id], gate),
    queryFn: () => api<{ apiKey: ApiKeyRecord }>(`/api/v1/api-keys/${id}`).then((r) => r.apiKey),
    enabled: gate.enabled,
    staleTime: API_KEY_STALE_MS,
  });
}
