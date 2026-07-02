/**
 * Lazy Steward runtime — the heavy `@stwd/sdk` / `@stwd/react` chunk.
 *
 * Loaded only by {@link StewardAuthProvider} when a token is present or the
 * route needs auth, so the wallet/Steward stack never lands on the first-paint
 * critical path (and never in the native bundle — the whole shell is
 * web-build-only).
 *
 * AuthTokenSync keeps the JWT → server-cookie sync and the refresh-ahead loop
 * (honoring `exp`) running while a cloud surface is mounted.
 */

import { writeStoredStewardToken } from "@elizaos/shared/steward-session-client";
import { StewardProvider, useAuth as useStewardAuth } from "@stwd/react";
// The @stwd/react components — notably <StewardLogin> on the app-auth authorize
// page (packages/ui/src/cloud-ui/components/auth/authorize-content.tsx) — are
// styled ENTIRELY by this scoped `.stwd-*` stylesheet (it drives layout, button
// borders/fills, and the input box via CSS custom properties). It was never
// imported anywhere, so <StewardLogin> rendered completely unstyled in prod: the
// authorize/sign-in buttons collapsed to plain inline text with icons floating
// above jammed labels and no input box. Import it here, co-located with the lazy
// web-only Steward chunk, so it loads exactly when the Steward UI mounts. Scoped
// to `.stwd-*` → touches nothing else. This module is dynamically imported
// (never in the Node barrel), so the .css never reaches a Node plugin loader.
import "@stwd/react/styles.css";
import { StewardClient } from "@stwd/sdk";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { scrubPersistedAgentProfileTokens } from "../../state/agent-profiles";
import { scrubPersistedActiveServerToken } from "../../state/persistence";
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
} from "./StewardProviderShared";

const REFRESH_CHECK_INTERVAL_MS = 60_000;
const REFRESH_AHEAD_SECS = 120;
type StewardProviderClient = ComponentProps<typeof StewardProvider>["client"];

// The Steward SDK UI (<StewardLogin> on the app-auth sign-in page, wallet,
// dashboards) otherwise renders with the SDK's default gold accent
// (DEFAULT_THEME.primaryColor = #D4A054). Override just the accent colors to
// Eliza's brand orange so the sign-in matches the rest of the product (the main
// /login page + the app shell are #FF5800). The SDK's dark surface/text defaults
// already match our surfaces, so no other fields need theming. Passed as the
// provider `theme` (Partial<TenantTheme>) → mapped to the scoped `.stwd-*` vars.
const ELIZA_STEWARD_THEME: ComponentProps<typeof StewardProvider>["theme"] = {
  primaryColor: "#FF5800",
  accentColor: "#FF5800",
};

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
          // Same stale-proxy guard as the refresh path: a still-valid token that
          // gets a 401 from the session-sync endpoint is far more likely a
          // misproxied control plane than a real revocation. Only clear once the
          // token is actually expired, so a stale staging proxy can't loop us.
          const current = readStoredToken();
          if (current && !tokenIsExpired(current)) {
            // Reset the dedupe marker so the next sync trigger (visibility,
            // storage, re-render) retries the cookie POST for this same token
            // once the endpoint recovers — otherwise the session would ride
            // out its lifetime with no HttpOnly cookie ever established.
            lastSyncedToken.current = null;
            console.warn(
              "[steward] Session-sync 401 but stored token still valid — keeping it (likely a stale control-plane proxy)",
            );
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
            // A refresh 401 normally means the session was revoked → clear so it
            // self-heals. But a STALE co-hosted proxy (staging's FRONTEND_ALIAS
            // pointing at the wrong control plane) 401s a still-VALID session,
            // and wiping it here kicks the user back to /login on every refresh
            // tick — the sign-in loop. So only clear when the stored token is
            // actually expired (keeping it is useless then); a still-valid token
            // rides until real expiry and any genuine revocation self-heals then.
            const stored = readStoredToken();
            if (!stored || tokenIsExpired(stored)) {
              if (wasAuthenticated.current && lastSyncedToken.current) {
                lastSyncedToken.current = null;
                wasAuthenticated.current = false;
              }
              clearStaleStewardSession();
            } else {
              console.warn(
                "[steward] Refresh 401 but stored token still valid — keeping it (likely a stale control-plane proxy, not a revoked session)",
              );
            }
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
      signOut: () => {
        // Drop the at-rest JWT from the persisted active server before the SDK
        // sign-out — leaving it in localStorage is an at-rest token leak. Keeps
        // the backend selection (kind/apiBase) so re-auth lands on the same one.
        // The same JWT is also copied into the per-agent profile records, so
        // scrub those too — otherwise the token survives at rest there.
        scrubPersistedActiveServerToken();
        scrubPersistedAgentProfileTokens();
        auth.signOut();
      },
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
  const client = useMemo(
    () =>
      new StewardClient({
        baseUrl: apiUrl,
        ...(tenantId && !isPlaceholderValue(tenantId) ? { tenantId } : {}),
      }),
    [apiUrl, tenantId],
  );
  const authConfig = useMemo(() => ({ baseUrl: apiUrl }), [apiUrl]);
  // @stwd/react bundles an older @stwd/sdk than the one pinned here. The
  // client classes are runtime-compatible, but TypeScript treats them as
  // nominally different because both versions declare private fields.
  const providerClient = client as unknown as StewardProviderClient;

  return (
    <StewardProvider
      client={providerClient}
      agentId="eliza-cloud"
      theme={ELIZA_STEWARD_THEME}
      auth={authConfig}
      tenantId={
        tenantId && !isPlaceholderValue(tenantId) ? tenantId : undefined
      }
    >
      <AuthTokenSync>{children}</AuthTokenSync>
    </StewardProvider>
  );
}
