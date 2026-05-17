import { useQuery } from "@tanstack/react-query";
import type {
  AdminModerationStatusResponse,
  AdminRole,
} from "@/lib/types/cloud-api";
import { apiFetch } from "../api-client";
import { authenticatedQueryKey, useAuthenticatedQueryGate } from "./auth-query";

export type AdminModerationStatus = AdminModerationStatusResponse;

function adminRoleFromHeader(value: string | null): AdminRole | null {
  return value === "super_admin" || value === "moderator" || value === "viewer"
    ? value
    : null;
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
