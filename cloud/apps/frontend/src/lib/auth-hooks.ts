/**
 * SPA auth hooks. Thin wrapper around `@/lib/hooks/use-session-auth`
 * (Steward provider + localStorage fallback) for the synchronous "is the
 * user logged in" answer.
 */

import { useSessionAuth } from "@/lib/hooks/use-session-auth";

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
