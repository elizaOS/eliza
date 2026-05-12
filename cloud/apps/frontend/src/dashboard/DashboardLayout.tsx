import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { useSessionAuth } from "@/lib/hooks/use-session-auth";
import { DashboardShell } from "../components/layout/dashboard-shell";

/**
 * Free Mode Paths (accessible without auth):
 * - /dashboard/chat - AI agent chat
 */
const FREE_MODE_PATHS = ["/dashboard/chat"];
const PLAYWRIGHT_TEST_AUTH_MARKER_COOKIE = "eliza-test-auth=1";
const AUTH_LOSS_GRACE_MS = 5000;

/**
 * Dashboard layout. Renders the sidebar + header chrome and an `<Outlet />`
 * for the active dashboard page. Handles auth gating: protected routes
 * redirect to `/login?returnTo=...`, with a 5s grace window so a transient
 * Steward token refresh doesn't yank the UI.
 */
export default function DashboardLayout() {
  const { ready, authenticated } = useSessionAuth();
  const { pathname, search } = useLocation();
  const playwrightTestAuthEnabled =
    import.meta.env.VITE_PLAYWRIGHT_TEST_AUTH === "true" ||
    (typeof process !== "undefined" && process.env?.NEXT_PUBLIC_PLAYWRIGHT_TEST_AUTH === "true");

  const hasBeenAuthenticated = useRef(false);
  const authLossTimerRef = useRef<number | null>(null);
  const [authGraceActive, setAuthGraceActive] = useState(false);

  if (authenticated) {
    hasBeenAuthenticated.current = true;
  }

  const hasPlaywrightTestSession =
    playwrightTestAuthEnabled &&
    typeof document !== "undefined" &&
    document.cookie.includes(PLAYWRIGHT_TEST_AUTH_MARKER_COOKIE);
  const authReady = ready || playwrightTestAuthEnabled;

  const isFreeModePath = FREE_MODE_PATHS.some((path) => pathname?.startsWith(path));
  const shouldAllowProtectedContent = authenticated || authGraceActive || hasPlaywrightTestSession;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleAnonMigrationComplete = () => {
      window.location.reload();
    };
    window.addEventListener("anon-migration-complete", handleAnonMigrationComplete);
    return () => window.removeEventListener("anon-migration-complete", handleAnonMigrationComplete);
  }, []);

  useEffect(() => {
    if (authLossTimerRef.current !== null) {
      window.clearTimeout(authLossTimerRef.current);
      authLossTimerRef.current = null;
    }

    if (!authReady || isFreeModePath) {
      setAuthGraceActive(false);
      return;
    }

    if (authenticated) {
      setAuthGraceActive(false);
      return;
    }

    if (hasBeenAuthenticated.current) {
      setAuthGraceActive(true);
      authLossTimerRef.current = window.setTimeout(() => {
        hasBeenAuthenticated.current = false;
        setAuthGraceActive(false);
      }, AUTH_LOSS_GRACE_MS);

      return () => {
        if (authLossTimerRef.current !== null) {
          window.clearTimeout(authLossTimerRef.current);
          authLossTimerRef.current = null;
        }
      };
    }

    setAuthGraceActive(false);
  }, [authReady, authenticated, isFreeModePath]);

  const loginRedirectTo =
    !shouldAllowProtectedContent && !isFreeModePath
      ? `/login?returnTo=${encodeURIComponent(pathname + search)}`
      : undefined;

  const minimalOutletChrome = pathname?.startsWith("/dashboard/chat");

  return (
    <DashboardShell
      authReady={authReady}
      loginRedirectTo={loginRedirectTo}
      minimalOutletChrome={minimalOutletChrome}
      headerAnonymous={!shouldAllowProtectedContent}
      headerAuthGraceActive={authGraceActive && !authenticated}
    />
  );
}
