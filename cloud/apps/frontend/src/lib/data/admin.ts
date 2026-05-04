import { useQuery } from "@tanstack/react-query";
import type { AdminModerationStatusResponse, AdminRole } from "@/lib/types/cloud-api";
import { api, apiFetch } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

export interface AdminOrgRow {
  id: string;
  name?: string | null;
  [key: string]: unknown;
}

export interface AdminUserRow {
  id: string;
  email?: string | null;
  wallet_address?: string | null;
  [key: string]: unknown;
}

export interface AdminAiPricingRow {
  id: string;
  provider: string;
  model: string;
  [key: string]: unknown;
}

export interface AdminServicePricingRow {
  id: string;
  service: string;
  [key: string]: unknown;
}

export interface AdminInfrastructureSummary {
  [key: string]: unknown;
}

export interface AdminMetricsSummary {
  [key: string]: unknown;
}

export interface AdminDockerContainer {
  id: string;
  [key: string]: unknown;
}

export interface AdminDockerNode {
  id: string;
  [key: string]: unknown;
}

export interface AdminHeadscaleNode {
  id: string;
  [key: string]: unknown;
}

export interface AdminRedemptionRow {
  id: string;
  status: string;
  [key: string]: unknown;
}

export function useAdminOrgs() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["admin", "orgs"], gate),
    queryFn: () =>
      api<{ orgs: AdminOrgRow[]; total: number }>("/api/v1/admin/orgs").then((r) => r.orgs),
    enabled: gate.enabled,
  });
}

export function useAdminUsers() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["admin", "users"], gate),
    queryFn: () =>
      api<{ users: AdminUserRow[]; total: number }>("/api/v1/admin/users").then((r) => r.users),
    enabled: gate.enabled,
  });
}

export function useAdminAiPricing() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["admin", "ai-pricing"], gate),
    queryFn: () =>
      api<{ pricing: AdminAiPricingRow[] }>("/api/v1/admin/ai-pricing").then((r) => r.pricing),
    enabled: gate.enabled,
  });
}

export function useAdminServicePricing(serviceId: string | undefined) {
  const gate = useAuthenticatedQueryGate(Boolean(serviceId));
  return useQuery({
    queryKey: authenticatedQueryKey(["admin", "service-pricing", serviceId ?? null], gate),
    queryFn: () =>
      api<{ pricing: AdminServicePricingRow[] }>(
        `/api/v1/admin/service-pricing?service_id=${encodeURIComponent(serviceId ?? "")}`,
      ).then((r) => r.pricing),
    enabled: gate.enabled,
  });
}

export function useAdminInfrastructure() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["admin", "infrastructure"], gate),
    queryFn: () => api<AdminInfrastructureSummary>("/api/v1/admin/infrastructure"),
    enabled: gate.enabled,
  });
}

export function useAdminInfrastructureContainers() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["admin", "infrastructure", "containers"], gate),
    queryFn: () =>
      api<{ containers?: AdminDockerContainer[] }>("/api/v1/admin/infrastructure/containers").then(
        (r) => r.containers ?? [],
      ),
    enabled: gate.enabled,
  });
}

export function useAdminMetrics() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["admin", "metrics"], gate),
    queryFn: () => api<AdminMetricsSummary>("/api/v1/admin/metrics"),
    enabled: gate.enabled,
  });
}

export function useAdminDockerContainers() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["admin", "docker-containers"], gate),
    queryFn: () =>
      api<{ containers?: AdminDockerContainer[] }>("/api/v1/admin/docker-containers").then(
        (r) => r.containers ?? [],
      ),
    enabled: gate.enabled,
  });
}

export function useAdminDockerNodes() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["admin", "docker-nodes"], gate),
    queryFn: () =>
      api<{ nodes?: AdminDockerNode[] }>("/api/v1/admin/docker-nodes").then((r) => r.nodes ?? []),
    enabled: gate.enabled,
  });
}

export function useAdminHeadscale() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["admin", "headscale"], gate),
    queryFn: () =>
      api<{ nodes?: AdminHeadscaleNode[] }>("/api/v1/admin/headscale").then((r) => r.nodes ?? []),
    enabled: gate.enabled,
  });
}

export type AdminModerationStatus = AdminModerationStatusResponse;

function adminRoleFromHeader(value: string | null): AdminRole | null {
  return value === "super_admin" || value === "moderator" || value === "viewer" ? value : null;
}

/**
 * HEAD /api/v1/admin/moderation — used as the admin gate. Returns the
 * X-Is-Admin / X-Admin-Role headers parsed into a typed shape.
 *
 * The user's admin role is essentially static for the lifetime of a session;
 * relax to 5 minutes so the gate doesn't refetch every nav.
 */
export function useAdminModerationStatus() {
  const gate = useAuthenticatedQueryGate();
  return useQuery<AdminModerationStatus>({
    queryKey: authenticatedQueryKey(["admin", "moderation", "status"], gate),
    queryFn: async () => {
      const res = await apiFetch("/api/v1/admin/moderation", {
        method: "HEAD",
      });
      return {
        isAdmin: res.headers.get("X-Is-Admin") === "true",
        role: adminRoleFromHeader(res.headers.get("X-Admin-Role")),
      };
    },
    enabled: gate.enabled,
    staleTime: 5 * 60 * 1000,
  });
}

export function useAdminRedemptions() {
  const gate = useAuthenticatedQueryGate();
  return useQuery({
    queryKey: authenticatedQueryKey(["admin", "redemptions"], gate),
    queryFn: () =>
      api<{ redemptions: AdminRedemptionRow[] }>("/api/admin/redemptions").then(
        (r) => r.redemptions,
      ),
    enabled: gate.enabled,
  });
}
