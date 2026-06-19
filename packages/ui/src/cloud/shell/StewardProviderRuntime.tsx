/**
 * Lazy Steward runtime — the heavy `@stwd/sdk` / `@stwd/react` chunk.
 *
 * Ported from `@elizaos/cloud-frontend/src/providers/StewardProviderRuntime.tsx`.
 * Loaded only by {@link StewardAuthProvider} when a token is present or the
 * route needs auth, so the wallet/Steward stack never lands on the first-paint
 * critical path (and never in the native bundle — the whole shell is
 * web-build-only).
 *
 * AuthTokenSync keeps the JWT → server-cookie sync and the refresh-ahead loop
 * (honoring `exp`) running while a cloud surface is mounted.
 */

import { writeStoredStewardToken } from "@elizaos/shared/steward-session-client";
import type { StewardClient as StewardReactClient } from "@stwd/react";
import { StewardProvider, useAuth as useStewardAuth } from "@stwd/react";
import { StewardClient } from "@stwd/sdk";
import { type ReactNode, useEffect, useMemo, useRef } from "react";
import {
  clearServerStewardSessionCookies,
  clearStaleStewardSession,
  configuredRefreshEndpoint,
  configuredSessionEndpoint,
  isPlaceholderValue,
  LocalStewardAuthContext,
  type LocalStewardAuthValue,
  readStoredToken,
  tokenIsExpired,
  tokenSecsRemaining,
} from "./StewardProvider";

const REFRESH_CHECK_INTERVAL_MS = 60_000;
const REFRESH_AHEAD_SECS = 120;

function AuthTokenSync({ children }: { children: ReactNode }) {
  const auth = useStewardAuth();
  const { isAuthenticated, user } = auth;
  const lastSyncedToken = useRef<string | null>(null);
  const wasAuthenticated = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional re-run trigger
  useEffect(() => {
    const syncToken = () => {
      const token = readStoredToken();
      if (!token) {
        if (wasAuthenticated.current && lastSyncedToken.current) {
          lastSyncedToken.current = null;
          wasAuthenticated.current = false;
          clearServerStewardSessionCookies();
        }
        return;
      }

      if (tokenIsExpired(token)) return;
      if (token === lastSyncedToken.current) return;

      lastSyncedToken.current = token;
      wasAuthenticated.current = true;

      fetch(configuredSessionEndpoint(), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      })
        .then(async (res) => {
          if (res.ok) {
            window.dispatchEvent(
              new CustomEvent("steward-token-sync", {
                detail: { token, userId: user?.id },
              }),
            );
            return;
          }

          const body = (await res.json().catch(() => null)) as {
            code?: string;
          } | null;
          if (body?.code === "server_secret_missing") {
            console.warn(
              "[steward] /api/auth/steward-session reports server-side secret missing - keeping localStorage token; cookie path will fail until the Worker is configured.",
            );
            return;
          }
          if (res.status !== 401) {
            console.warn("[steward] Server did not accept stored token", {
              status: res.status,
              code: body?.code,
            });
            return;
          }
          console.warn(
            "[steward] Stored token rejected by server (401) - clearing",
          );
          lastSyncedToken.current = null;
          wasAuthenticated.current = false;
          clearStaleStewardSession();
        })
        .catch((err) =>
          console.warn("[steward] Failed to set session cookie", err),
        );
    };

    // Single-flight: never run two refreshes at once. The refresh-token rotation
    // is not concurrency-safe, so overlapping refreshes (the timer plus a 401
    // nudge, say) would race and one would invalidate the other's refresh token.
    let refreshInFlight: Promise<void> | null = null;

    const checkAndRefresh = async (force = false): Promise<void> => {
      const token = readStoredToken();
      if (!token) return;
      if (!force) {
        const secs = tokenSecsRemaining(token);
        if (secs !== null && secs >= REFRESH_AHEAD_SECS) return;
      }
      if (refreshInFlight) return refreshInFlight;

      refreshInFlight = (async () => {
        try {
          const res = await fetch(configuredRefreshEndpoint(), {
            method: "POST",
            credentials: "include",
          });
          if (res.ok) {
            const body = (await res.json().catch(() => null)) as {
              token?: string;
            } | null;
            if (body?.token) {
              writeStoredStewardToken(body.token);
              lastSyncedToken.current = body.token;
              wasAuthenticated.current = true;
            }
            try {
              window.dispatchEvent(new CustomEvent("steward-token-sync"));
            } catch {
              // ignore
            }
            return;
          }
          if (res.status === 401) {
            if (wasAuthenticated.current && lastSyncedToken.current) {
              lastSyncedToken.current = null;
              wasAuthenticated.current = false;
            }
            clearStaleStewardSession();
          }
        } catch (err) {
          console.warn("[steward] Auto-refresh failed", err);
        }
      })().finally(() => {
        refreshInFlight = null;
      });

      return refreshInFlight;
    };

    syncToken();
    void checkAndRefresh();

    const refreshInterval = setInterval(() => {
      void checkAndRefresh();
    }, REFRESH_CHECK_INTERVAL_MS);

    const handler = () => syncToken();
    window.addEventListener("storage", handler);

    const visibilityHandler = () => {
      if (document.visibilityState === "visible") {
        syncToken();
        void checkAndRefresh();
      }
    };
    document.addEventListener("visibilitychange", visibilityHandler);

    const onlineHandler = () => {
      void checkAndRefresh();
    };
    window.addEventListener("online", onlineHandler);

    // A 401 from any authed API call (dispatched by api-client) means the server
    // rejected our session — force a refresh-or-clear so a revoked/expired token
    // self-heals instead of leaving the UI "authed" until the next interaction.
    const unauthorizedHandler = () => {
      void checkAndRefresh(true);
    };
    window.addEventListener("steward-unauthorized", unauthorizedHandler);

    return () => {
      clearInterval(refreshInterval);
      window.removeEventListener("storage", handler);
      document.removeEventListener("visibilitychange", visibilityHandler);
      window.removeEventListener("online", onlineHandler);
      window.removeEventListener("steward-unauthorized", unauthorizedHandler);
    };
  }, [isAuthenticated, user]);

  // Map the SDK context to the local context shape explicitly. The structural
  // pass-through is fragile across @stwd/sdk resolutions; verifyEmailCallback
  // must narrow the MFA-required union before exposing tokens.
  const localAuth = useMemo<LocalStewardAuthValue>(
    () => ({
      isAuthenticated: auth.isAuthenticated,
      isLoading: auth.isLoading,
      user: auth.user
        ? {
            id: auth.user.id,
            email: auth.user.email ?? undefined,
            walletAddress: auth.user.walletAddress,
          }
        : null,
      session: auth.session,
      signOut: () => auth.signOut(),
      getToken: () => auth.getToken(),
      verifyEmailCallback: async (token: string, email: string) => {
        const result = await auth.verifyEmailCallback(token, email);
        if ("mfaRequired" in result) {
          throw new Error("MFA required — not yet supported in this client.");
        }
        return { token: result.token, refreshToken: result.refreshToken };
      },
    }),
    [auth],
  );

  return (
    <LocalStewardAuthContext.Provider value={localAuth}>
      {children}
    </LocalStewardAuthContext.Provider>
  );
}

export default function StewardAuthRuntimeProvider({
  apiUrl,
  children,
  tenantId,
}: {
  apiUrl: string;
  children: ReactNode;
  tenantId?: string;
}) {
  // @stwd/react bundles an older @stwd/sdk than the one pinned here. The
  // StewardClient classes are public-API-identical and differ only by added
  // private fields, so the cast bridges the nominal mismatch; StewardProvider
  // only calls the public `client.getBaseUrl()` at runtime.
  const client = useMemo(
    () =>
      new StewardClient({
        baseUrl: apiUrl,
        ...(tenantId && !isPlaceholderValue(tenantId) ? { tenantId } : {}),
      }) as unknown as StewardReactClient,
    [apiUrl, tenantId],
  );
  const authConfig = useMemo(() => ({ baseUrl: apiUrl }), [apiUrl]);
  const providerClient = client as unknown as React.ComponentProps<
    typeof StewardProvider
  >["client"];

  return (
    <StewardProvider
      client={providerClient}
      agentId="eliza-cloud"
      auth={authConfig}
      tenantId={
        tenantId && !isPlaceholderValue(tenantId) ? tenantId : undefined
      }
    >
      <AuthTokenSync>{children}</AuthTokenSync>
    </StewardProvider>
  );
}
