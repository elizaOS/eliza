import { useQuery } from "@tanstack/react-query";
import { api } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

export interface Container {
  id: string;
  name: string;
  description: string | null;
  status: string;
  load_balancer_url: string | null;
  node_id: string | null;
  volume_path: string | null;
  port: number;
  desired_count: number;
  cpu: number;
  memory: number;
  last_deployed_at: string | Date | null;
  created_at: string | Date;
  error_message: string | null;
}

interface ApiEnvelope<T> {
  success: boolean;
  data: T;
  error?: string;
}

/** GET /api/v1/containers — list containers for the caller's organization. */
export function useContainers() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["containers"], gate),
    queryFn: async () => {
      const res = await api<ApiEnvelope<Container[]>>("/api/v1/containers");
      return res.data;
    },
    enabled: gate.enabled,
  });
}

/** GET /api/v1/containers/:id — container summary. */
export function useContainer(id: string | undefined) {
  const gate = useAuthenticatedQueryGate(Boolean(id));
  return useQuery({
    queryKey: authenticatedQueryKey(["container", id], gate),
    queryFn: async () => {
      const res = await api<ApiEnvelope<Container>>(`/api/v1/containers/${id}`);
      return res.data;
    },
    enabled: gate.enabled,
  });
}
