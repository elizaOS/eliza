"use client";

import { writeStoredStewardToken } from "@elizaos/shared/steward-session-client";
import type { StewardClient as StewardReactClient } from "@stwd/react";
import { StewardProvider, useAuth as useStewardAuth } from "@stwd/react";
import { StewardClient } from "@stwd/sdk";
import { useEffect, useMemo, useRef } from "react";
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

function AuthTokenSync({ children }: { children: React.ReactNode }) {
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

    const checkAndRefresh = async () => {
      const token = readStoredToken();
      if (token) {
        const secs = tokenSecsRemaining(token);
        if (secs !== null && secs >= REFRESH_AHEAD_SECS) return;
      } else {
        return;
      }

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

    return () => {
      clearInterval(refreshInterval);
      window.removeEventListener("storage", handler);
      document.removeEventListener("visibilitychange", visibilityHandler);
      window.removeEventListener("online", onlineHandler);
    };
  }, [isAuthenticated, user]);

  // Map the SDK context to the local context shape explicitly instead of
  // passing the SDK object through. The structural pass-through is fragile
  // across @stwd/sdk resolutions (0.8.x vs 0.10.x nest differently under
  // @stwd/react), and verifyEmailCallback must narrow the 0.10.x
  // MFA-required union before exposing tokens.
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
  children: React.ReactNode;
  tenantId?: string;
}) {
  // @stwd/react@0.7.2 bundles @stwd/sdk@^0.8.0, while this package pins
  // @stwd/sdk@^0.10.1 (bumped for the passkey-login fix). The two StewardClient
  // classes are public-API-identical and differ only by added private fields,
  // so they are nominally incompatible. StewardProvider only calls the public
  // `client.getBaseUrl()` at runtime, so the 0.10.1 client is safe to pass; the
  // cast bridges the private-field nominal mismatch until @stwd/react ships a
  // release tracking @stwd/sdk@0.10.x.
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
