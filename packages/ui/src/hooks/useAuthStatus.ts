/**
 * useAuthStatus — monitors the current auth state via GET /api/auth/me.
 *
 * Returns a discriminated union that lets the shell decide whether to render
 * the login gate or the main dashboard.
 *
 * Fail-closed: network errors are treated as server-unavailable so the app
 * never leaks the dashboard, but also does not imply bad credentials.
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
   * Useful when the app knows auth should be deferred (e.g. during first-run setup).
   */
  skip?: boolean;
  /**
   * Subscribe to the latest auth status without starting a fetch or poll loop.
   * Useful for read-only shell metadata that should reuse the app-level check.
   */
  observeOnly?: boolean;
}

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
// The local/on-device agent answers 503 for a few seconds while it binds after
// a cold launch (`authMe` maps every unreachable case to 503). Retry through
// that window before declaring the backend unreachable, so a boot race doesn't
// strand the user on the failure screen until the next 5-minute poll. A genuine
// down backend still resolves to `server_unavailable` after the budget; a 401
// is authoritative and never retried.
const SERVER_UNAVAILABLE_RETRIES = 10;
const SERVER_UNAVAILABLE_RETRY_MS = 1000;
const authStatusSubscribers = new Set<(state: AuthStatusState) => void>();
let authStatusSnapshot: AuthStatusState = { phase: "loading" };
let authStatusFetch: Promise<void> | null = null;

function publishAuthStatus(state: AuthStatusState): void {
  authStatusSnapshot = state;
  for (const subscriber of authStatusSubscribers) {
    subscriber(state);
  }
}

async function fetchAuthStatus(): Promise<void> {
  if (authStatusFetch) return authStatusFetch;

  publishAuthStatus(
    authStatusSnapshot.phase === "loading"
      ? authStatusSnapshot
      : { phase: "loading" },
  );

  authStatusFetch = (async () => {
    for (let attempt = 0; ; attempt += 1) {
      const result = await authMe();
      if (result.ok === true) {
        publishAuthStatus({
          phase: "authenticated",
          identity: result.identity,
          session: result.session,
          access: result.access,
        });
        return;
      }
      if (result.status === 503) {
        if (attempt < SERVER_UNAVAILABLE_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, SERVER_UNAVAILABLE_RETRY_MS),
          );
          continue;
        }
        publishAuthStatus({ phase: "server_unavailable" });
        return;
      }
      publishAuthStatus({
        phase: "unauthenticated",
        reason:
          result.reason === "remote_auth_required" ||
          result.reason === "remote_password_not_configured"
            ? result.reason
            : undefined,
        access: result.access,
      });
      return;
    }
  })().finally(() => {
    authStatusFetch = null;
  });

  return authStatusFetch;
}

/**
 * True once the app-level auth probe (App.tsx's `useAuthStatus`) has resolved
 * to an authenticated session. Read-only: subscribes to the shared snapshot
 * without starting its own fetch or poll, so gating on it adds zero network
 * traffic. Background pollers and shell data loaders must not start until this
 * is true — an unauthenticated shell otherwise streams 401s into the API rate
 * limiter (#11084).
 */
export function useIsAuthenticated(): boolean {
  const { state } = useAuthStatus({ observeOnly: true });
  return state.phase === "authenticated";
}

/**
 * Test/story seam for the #11084 auth gate: publish a synthetic status into the
 * shared snapshot (and to subscribers) so `useIsAuthenticated`-gated loaders
 * run without a live `/api/auth/me` probe. Harness-only — the jsdom story
 * smoke + browser story gate have no auth backend, so without this the
 * snapshot stays `loading` forever and every gated widget self-hides (the
 * home-screen e2e solves the same gap by aliasing this module to
 * `home-screen-fixture.auth-stub.ts`). Returns a restore that re-publishes
 * the previous snapshot. Never call from product code.
 */
export function __setAuthStatusForTests(state: AuthStatusState): () => void {
  const previous = authStatusSnapshot;
  publishAuthStatus(state);
  return () => {
    publishAuthStatus(previous);
  };
}

export function useAuthStatus(options: UseAuthStatusOptions = {}): {
  state: AuthStatusState;
  refetch: () => void;
} {
  const {
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    skip = false,
    observeOnly = false,
  } = options;
  const [state, setState] = useState<AuthStatusState>(authStatusSnapshot);
  const mountedRef = useRef(true);

  const fetch = useCallback(async () => {
    if (!mountedRef.current) return;
    await fetchAuthStatus();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    authStatusSubscribers.add(setState);
    setState(authStatusSnapshot);
    if (!skip && !observeOnly) void fetch();
    return () => {
      mountedRef.current = false;
      authStatusSubscribers.delete(setState);
    };
  }, [skip, observeOnly, fetch]);

  useEffect(() => {
    if (skip || observeOnly || pollIntervalMs === 0) return;
    const id = setInterval(() => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      void fetch();
    }, pollIntervalMs);

    const visibilityHandler =
      typeof document !== "undefined"
        ? () => {
            if (document.visibilityState === "visible") void fetch();
          }
        : undefined;
    if (visibilityHandler) {
      document.addEventListener("visibilitychange", visibilityHandler);
    }

    return () => {
      clearInterval(id);
      if (visibilityHandler && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", visibilityHandler);
      }
    };
  }, [skip, observeOnly, pollIntervalMs, fetch]);

  return { state, refetch: fetch };
}
