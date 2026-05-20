"use client";

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

  return (
    <LocalStewardAuthContext.Provider value={auth}>
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
  const client = useMemo(
    () =>
      new StewardClient({
        baseUrl: apiUrl,
        ...(tenantId && !isPlaceholderValue(tenantId) ? { tenantId } : {}),
      }),
    [apiUrl, tenantId],
  );
  const authConfig = useMemo(() => ({ baseUrl: apiUrl }), [apiUrl]);

  return (
    <StewardProvider
      client={client}
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
