/**
 * THE single admin gate for the app-hosted Eliza Cloud admin surfaces.
 *
 * Consolidates the auth/role mess that existed in `@elizaos/cloud-frontend`:
 * that package had two parallel admin hooks
 * (`lib/data/admin.ts` — a react-query gate on the moderation HEAD endpoint —
 * and `hooks/use-admin.ts` — a hand-rolled module-cache + in-flight-dedupe hook
 * keyed on a wallet address, with the anvil-default-wallet fallback) plus four
 * different dev-bypass conventions scattered across the route layout, the page,
 * and the env flags (`import.meta.env.DEV`, `process.env.NODE_ENV`,
 * `NEXT_PUBLIC_DEVNET`, `VITE_ELIZA_CLOUD_LOCAL_DEV_ADMIN`).
 *
 * This module replaces all of that with ONE source of truth:
 *
 *   - **Role:** the `HEAD /api/v1/admin/moderation` endpoint, parsed from its
 *     `X-Is-Admin` / `X-Admin-Role` response headers — the server is the only
 *     authority on who is an admin and what role they hold.
 *   - **Dev rule (documented):** in local dev (`import.meta.env.DEV`) any
 *     authenticated user reaches the admin surfaces as `super_admin`, so the
 *     pages are reviewable/e2e-able without holding a specific allowlisted
 *     wallet. Production keeps the role gate intact (the HEAD check decides).
 *
 * The role is effectively static for the lifetime of a session, so the query is
 * cached for 5 minutes; the authenticated-query gate partitions it per user.
 */

import type {
  AdminModerationStatusResponse,
  AdminRole,
} from "@elizaos/cloud-shared/lib/types/cloud-api";
import { useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { apiFetch } from "../../lib/api-client";
import { LocalStewardAuthContext } from "../../shell/StewardProvider";

export type AdminGateStatus = AdminModerationStatusResponse;

/** Whether the local-dev bypass is active (any authed user is super_admin). */
export function isAdminDevBypass(): boolean {
  return Boolean(import.meta.env.DEV);
}

function adminRoleFromHeader(value: string | null): AdminRole | null {
  return value === "super_admin" || value === "moderator" || value === "viewer"
    ? value
    : null;
}

interface AdminAuthGate {
  enabled: boolean;
  userId: string | null;
}

/**
 * Read the Steward session and derive whether the admin gate query may run.
 * In dev the query is skipped entirely (the bypass synthesises the role), so it
 * is gated on an authenticated session existing at all.
 */
function useAdminAuthGate(): AdminAuthGate {
  const auth = useContext(LocalStewardAuthContext);
  const ready = auth ? !auth.isLoading : true;
  const authenticated = auth?.isAuthenticated ?? false;
  return {
    enabled: ready && authenticated,
    userId: auth?.user?.id ?? null,
  };
}

export interface UseAdminGateResult {
  /** Whether the current user may see the admin surfaces. */
  isAdmin: boolean;
  /** Resolved admin role, or null when not an admin. */
  role: AdminRole | null;
  /** Whether the gate is still resolving (auth or the HEAD probe in flight). */
  isLoading: boolean;
  /** Whether the gate could not be resolved (HEAD probe failed). */
  isError: boolean;
  /** Whether an authenticated Steward session is present at all. */
  isAuthenticated: boolean;
}

/**
 * The consolidated admin gate. Returns `{ isAdmin, role, ... }` for the route
 * gate (`AdminGate`), the admin chrome, and per-action role checks (e.g. only
 * `super_admin` can add/revoke admins).
 */
export function useAdminGate(): UseAdminGateResult {
  const gate = useAdminAuthGate();
  const devBypass = isAdminDevBypass();

  const query = useQuery<AdminGateStatus>({
    queryKey: ["admin", "gate", "status", gate.userId],
    queryFn: async () => {
      const res = await apiFetch("/api/v1/admin/moderation", {
        method: "HEAD",
      });
      return {
        isAdmin: res.headers.get("X-Is-Admin") === "true",
        role: adminRoleFromHeader(res.headers.get("X-Admin-Role")),
      };
    },
    // In dev the role is synthesised; never hit the network for the gate.
    enabled: gate.enabled && !devBypass,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  if (devBypass) {
    return {
      isAdmin: gate.enabled,
      role: gate.enabled ? "super_admin" : null,
      isLoading: false,
      isError: false,
      isAuthenticated: gate.enabled,
    };
  }

  return {
    isAdmin: query.data?.isAdmin ?? false,
    role: query.data?.role ?? null,
    isLoading: gate.enabled && query.isLoading,
    isError: query.isError,
    isAuthenticated: gate.enabled,
  };
}
