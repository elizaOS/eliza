/**
 * useAuthStatus — monitors the current auth state via GET /api/auth/me.
 *
 * Returns a discriminated union that lets the shell decide whether to render
 * the login gate or the main dashboard.
 *
 * Fail-closed: network errors are treated as 401 so the login gate renders
 * rather than the dashboard leaking in an unknown auth state.
 *
 * Call `refetch()` after login / logout to force a fresh check.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AuthAccessInfo,
  type AuthIdentity,
  type AuthSessionInfo,
  authMe,
} from "../api/auth-client";

export type AuthStatusState =
  | { phase: "loading" }
  | {
      phase: "authenticated";
      identity: AuthIdentity;
      session: AuthSessionInfo;
      access: AuthAccessInfo;
    }
  | {
      phase: "unauthenticated";
      reason?: "remote_auth_required" | "remote_password_not_configured";
      access?: AuthAccessInfo;
    }
  | { phase: "server_unavailable" };

interface UseAuthStatusOptions {
  /**
   * How often to re-check in the background (ms).
   * Defaults to 5 minutes. Set to 0 to disable background polling.
   */
  pollIntervalMs?: number;
  /**
   * When true the hook will NOT start its initial fetch.
   * Useful when the app knows auth is not yet relevant (e.g. during onboarding).
   */
  skip?: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

export function useAuthStatus(options: UseAuthStatusOptions = {}): {
  state: AuthStatusState;
  refetch: () => void;
} {
  const { pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, skip = false } = options;
  const [state, setState] = useState<AuthStatusState>({ phase: "loading" });
  const mountedRef = useRef(true);

  const fetch = useCallback(async () => {
    if (!mountedRef.current) return;
    setState((prev) =>
      prev.phase === "loading" ? prev : { phase: "loading" },
    );
    const result = await authMe();
    if (!mountedRef.current) return;

    if (result.ok === true) {
      setState({
        phase: "authenticated",
        identity: result.identity,
        session: result.session,
        access: result.access,
      });
    } else if (result.ok === false) {
      if (result.status === 503) {
        setState({ phase: "server_unavailable" });
      } else {
        setState({
          phase: "unauthenticated",
          reason:
            result.reason === "remote_auth_required" ||
            result.reason === "remote_password_not_configured"
              ? result.reason
              : undefined,
          access: result.access,
        });
      }
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    if (!skip) void fetch();
    return () => {
      mountedRef.current = false;
    };
  }, [skip, fetch]);

  useEffect(() => {
    if (skip || pollIntervalMs === 0) return;
    const id = setInterval(() => {
      void fetch();
    }, pollIntervalMs);
    return () => clearInterval(id);
  }, [skip, pollIntervalMs, fetch]);

  return { state, refetch: fetch };
}
