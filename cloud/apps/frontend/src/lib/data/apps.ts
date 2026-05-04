import { useQuery } from "@tanstack/react-query";
import type { App } from "@/db/schemas";
import { api } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

export type { App };

// Apps list changes only on create/edit/delete. Relax to 2 minutes so list
// pages don't refetch on every nav while still staying responsive after
// mutations (which also invalidate this key directly).
const APP_STALE_MS = 2 * 60 * 1000;

/** GET /api/v1/apps — list of the caller's apps. */
export function useApps() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["apps"], gate),
    queryFn: async () => {
      const data = await api<{ apps: App[] }>("/api/v1/apps");
      return data.apps;
    },
    enabled: gate.enabled,
    staleTime: APP_STALE_MS,
  });
}

/** GET /api/v1/apps/:id — single app record. */
export function useApp(id: string | undefined) {
  const gate = useAuthenticatedQueryGate(Boolean(id));
  return useQuery({
    queryKey: authenticatedQueryKey(["app", id], gate),
    queryFn: () => api<{ app: App }>(`/api/v1/apps/${id}`).then((r) => r.app),
    enabled: gate.enabled,
    staleTime: APP_STALE_MS,
  });
}
