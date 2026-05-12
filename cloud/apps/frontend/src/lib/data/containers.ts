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

export type ContainerInclude = "deployments" | "metrics" | "logs";

interface SidecarNotMigrated {
  not_yet_migrated: true;
  reason: string;
}

interface ContainerDetailData {
  container: Container;
  deployments?: unknown;
  metrics?: SidecarNotMigrated | unknown;
  logs?: SidecarNotMigrated | unknown;
}

/**
 * GET /api/v1/containers/:id?include=… — container summary plus any
 * requested side panels in a single round trip. Pass the same `include`
 * names that the dedicated subroute hooks would have queried.
 *
 * `metrics` and `logs` require the Hetzner-Docker SSH client and are only
 * served by the Node sidecar; when requested via `include` the Worker
 * returns a `not_yet_migrated` marker for those fields. Use the dedicated
 * `useContainerMetrics` / `useContainerLogs` hooks if/when those panels
 * are wired through the sidecar.
 */
export function useContainerDetail(id: string | undefined, include: ContainerInclude[] = []) {
  const gate = useAuthenticatedQueryGate(Boolean(id));
  const includeKey = include.length === 0 ? null : [...include].sort().join(",");
  return useQuery({
    queryKey: authenticatedQueryKey(["container-detail", id, includeKey], gate),
    queryFn: async () => {
      const qs = includeKey ? `?include=${includeKey}` : "";
      const res = await api<ApiEnvelope<ContainerDetailData>>(`/api/v1/containers/${id}${qs}`);
      return res.data;
    },
    enabled: gate.enabled,
  });
}

/** GET /api/v1/containers/:id/deployments — deployment history. */
export function useContainerDeployments(id: string | undefined) {
  const gate = useAuthenticatedQueryGate(Boolean(id));
  return useQuery({
    queryKey: authenticatedQueryKey(["container-deployments", id], gate),
    queryFn: () => api<ApiEnvelope<unknown>>(`/api/v1/containers/${id}/deployments`),
    enabled: gate.enabled,
  });
}

/** GET /api/v1/containers/:id/metrics — runtime metrics. */
export function useContainerMetrics(id: string | undefined) {
  const gate = useAuthenticatedQueryGate(Boolean(id));
  return useQuery({
    queryKey: authenticatedQueryKey(["container-metrics", id], gate),
    queryFn: () => api<ApiEnvelope<unknown>>(`/api/v1/containers/${id}/metrics?period=60`),
    enabled: gate.enabled,
  });
}

/** GET /api/v1/containers/:id/logs — container logs. */
export function useContainerLogs(id: string | undefined) {
  const gate = useAuthenticatedQueryGate(Boolean(id));
  return useQuery({
    queryKey: authenticatedQueryKey(["container-logs", id], gate),
    queryFn: () => api<ApiEnvelope<unknown>>(`/api/v1/containers/${id}/logs`),
    enabled: gate.enabled,
  });
}

/** GET /api/v1/containers/quota — org container quota. */
export function useContainerQuota() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["container-quota"], gate),
    queryFn: () => api<ApiEnvelope<unknown>>("/api/v1/containers/quota"),
    enabled: gate.enabled,
  });
}

/** POST /api/v1/containers/credentials — deprecated credential vending endpoint. */
export function useContainerCredentials() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["container-credentials"], gate),
    queryFn: () => api<ApiEnvelope<unknown>>("/api/v1/containers/credentials", { method: "POST" }),
    enabled: gate.enabled,
  });
}
