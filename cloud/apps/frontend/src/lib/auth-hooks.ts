/**
 * SPA auth hooks. Builds on top of `@/lib/hooks/use-session-auth` (Steward
 * provider + localStorage fallback) for the synchronous "is the user logged
 * in" answer, and a TanStack Query against the user/me endpoint when a route
 * needs the full server-resolved user record (org, role, etc).
 */

import { useQuery } from "@tanstack/react-query";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import { ApiError, api } from "./api-client";

export interface CurrentUser {
  id: string;
  email: string | null;
  organization_id: string | null;
  organization: { id: string; name?: string; is_active?: boolean } | null;
  is_active: boolean;
  role: string | null;
  steward_id: string | null;
  wallet_address: string | null;
  is_anonymous: boolean;
}

async function fetchCurrentUser(): Promise<CurrentUser | null> {
  try {
    const data = await api<{ user: CurrentUser }>("/api/users/me");
    return data.user;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

/**
 * Returns the canonical user record (DB-resolved) plus loading state.
 *
 * For the synchronous "is there a session?" check (used by guards / redirects)
 * prefer `useSessionAuth()` directly — it reads the Steward provider + local
 * storage without a network round trip.
 *
 * @deprecated Prefer `useUserProfile` from `@/lib/data/user` — it hits the
 * same effective endpoint (`/api/v1/user`) used by every other consumer and
 * exposes the richer `UserProfile` shape, so call sites converge on a single
 * cache key. `useCurrentUser` calls `/api/users/me`, returns a thinner
 * `CurrentUser` shape, and exists only for the legacy admin layout (now
 * migrated). New code should use `useUserProfile`.
 */
export function useCurrentUser() {
  const session = useSessionAuth();
  const enabled = session.ready && session.authenticated;

  const query = useQuery({
    queryKey: ["currentUser", session.user?.id ?? null],
    queryFn: fetchCurrentUser,
    enabled,
  });

  return {
    ...query,
    session,
    user: query.data ?? null,
    isAuthenticated: session.authenticated,
    isReady: session.ready,
  };
}

/**
 * Returns the session state for protected pages.
 *
 * Historically this hook also scheduled a `navigate("/login")` from a
 * `useEffect` when the session resolved to unauthenticated, which caused a
 * flash of the dashboard skeleton between first paint and the redirect.
 * The redirect is now performed synchronously by `DashboardLayout` (it
 * renders `<Navigate />` instead of mounting `<Outlet />`), so the page
 * never paints in an unauthenticated state to begin with.
 *
 * Page-level call sites still get the same `{ ready, authenticated, ... }`
 * shape they used to.
 */
export function useRequireAuth() {
  return useSessionAuth();
}
