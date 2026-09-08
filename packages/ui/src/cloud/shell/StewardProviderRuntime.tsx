/**
 * Lazy Steward runtime — the heavy `@elizaos/login` / `@elizaos/ui` chunk.
 *
 * Loaded only by {@link StewardAuthProvider} when a token is present or the
 * route needs auth, so the wallet/Steward stack never lands on the first-paint
 * critical path (and never in the native bundle — the whole shell is
 * web-build-only).
 *
 * AuthTokenSync keeps the JWT → server-cookie sync and the refresh-ahead loop
 * (honoring `exp`) running while a cloud surface is mounted.
 */

import { LoginAuth, LoginClient } from "@elizaos/login";
import {
  getStewardTabSessionAuthorityCoordinator,
  StewardSessionAuthorityError,
  type StewardSessionAuthoritySnapshot,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import {
  type ComponentProps,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { dispatchStewardSessionChange } from "../../events/steward-session-event";
import { LoginProvider, useAuth as useStewardAuth } from "../../login/index";
import { scrubPersistedAgentProfileTokens } from "../../state/agent-profiles";
import { scrubPersistedActiveServerToken } from "../../state/persistence";
import { reportRendererDiagnostic } from "../../utils/renderer-diagnostics";
import {
  consumeStewardServerCookieSynced,
  invalidateStewardServerCookieSyncMarker,
} from "../lib/steward-session-cookie-sync-marker";
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

type RuntimeAuthOwner = {
  auth: LoginAuth;
  subscribers: Set<symbol>;
};
// React resubscription must not replace the SDK behind an in-flight one-time
// callback. Owners are document-local and isolated by configured API + tenant;
// the last real departure releases the owner after immediate remounts settle.
const runtimeAuthOwners = new WeakMap<
  Document,
  Map<string, RuntimeAuthOwner>
>();

function useRuntimeAuthOwner(
  apiUrl: string,
  tenantId: string | undefined,
): LoginAuth {
  const owner = useMemo(() => {
    const create = (): RuntimeAuthOwner => ({
      auth: new LoginAuth({ baseUrl: apiUrl, tenantId }),
      subscribers: new Set(),
    });
    if (typeof document === "undefined") return { entry: create() };
    let registry = runtimeAuthOwners.get(document);
    if (!registry) {
      registry = new Map();
      runtimeAuthOwners.set(document, registry);
    }
    const key = JSON.stringify([apiUrl, tenantId]);
    let entry = registry.get(key);
    if (!entry) {
      entry = create();
      registry.set(key, entry);
    }
    return { entry, registry, key };
  }, [apiUrl, tenantId]);
  useEffect(() => {
    const subscriber = Symbol("steward-runtime");
    owner.entry.subscribers.add(subscriber);
    return () => {
      owner.entry.subscribers.delete(subscriber);
      queueMicrotask(() => {
        if (
          owner.registry &&
          owner.key &&
          owner.entry.subscribers.size === 0 &&
          owner.registry.get(owner.key) === owner.entry
        ) {
          owner.registry.delete(owner.key);
        }
      });
    };
  }, [owner]);
  return owner.entry.auth;
}

type StewardResponseBody = { code?: string; token?: string };

async function parseStewardResponseBody(
  response: Response,
): Promise<StewardResponseBody | undefined> {
  try {
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new TypeError("Steward response body must be an object");
    }
    const record = body as Record<string, unknown>;
    return {
      ...(typeof record.code === "string" ? { code: record.code } : {}),
      ...(typeof record.token === "string" ? { token: record.token } : {}),
    };
  } catch (error) {
    // error-policy:J3 untrusted response bodies remain explicitly invalid;
    // callers continue using the HTTP status but never mistake parse failure
    // for a valid empty payload.
    reportRendererDiagnostic({
      scope: "steward.invalid-response-body",
      error,
      severity: "warning",
      context: { status: response.status, url: response.url },
    });
    return undefined;
  }
}

// The Steward SDK UI (<StewardLogin> on the app-auth sign-in page, wallet,
// dashboards) otherwise renders with the SDK's default gold accent
// (DEFAULT_THEME.primaryColor = #D4A054). Override just the accent colors to
// Eliza's brand orange so the sign-in matches the rest of the product (the main
// /login page + the app shell use the --accent brand orange). The SDK's dark surface/text defaults
// already match our surfaces, so no other fields need theming. Passed as the
// provider `theme` (Partial<TenantTheme>) → mapped to the scoped `.stwd-*` vars.
const ELIZA_STEWARD_THEME: ComponentProps<typeof LoginProvider>["theme"] = {
  primaryColor: "var(--accent)",
  accentColor: "var(--accent)",
};

function AuthTokenSync({ children }: { children: ReactNode }) {
  const auth = useStewardAuth();
  const { isAuthenticated, user } = auth;
  const lastSyncedAuthority = useRef<StewardSessionAuthoritySnapshot | null>(
    null,
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: auth transitions rebind the runtime listeners
  useEffect(() => {
    const coordinator = getStewardTabSessionAuthorityCoordinator();
    let lifecycle = new AbortController();
    let hidden = false;
    let refreshInFlight: Promise<void> | null = null;
    let refreshOwner: AbortController | null = null;

    const reportFailure = (scope: string, error: unknown) => {
      // error-policy:J4 superseded/unmounted work deliberately publishes no
      // authority; other failures remain observable renderer diagnostics.
      if (
        error instanceof StewardSessionAuthorityError &&
        (error.code === "STEWARD_SESSION_AUTHORITY_SUPERSEDED" ||
          error.code === "STEWARD_SESSION_AUTHORITY_CANCELLED")
      )
        return;
      reportRendererDiagnostic({ scope, error, severity: "warning" });
    };
    const expectedOptions = (snapshot: StewardSessionAuthoritySnapshot) => ({
      expectedToken: snapshot.token,
      expectedGeneration: snapshot.generation,
      expectedScope: snapshot.scope,
      signal: lifecycle.signal,
      // This runtime is web-only. Without a shared browser lock, automatic
      // cookie writes must stop; ordinary explicit sign-in remains separate.
      requireOriginWide: true,
    });

    const syncToken = async (): Promise<void> => {
      if (hidden || lifecycle.signal.aborted) return;
      try {
        if (!coordinator.originWide)
          throw new StewardSessionAuthorityError(
            "Automatic session synchronization requires origin-wide coordination",
            "STEWARD_SESSION_AUTHORITY_UNAVAILABLE",
          );
        const expected = coordinator.readSnapshot();
        const token = readStoredToken();
        if (!token) {
          if (lastSyncedAuthority.current) {
            lastSyncedAuthority.current = null;
            clearServerStewardSessionCookies({
              signal: lifecycle.signal,
              requireOriginWide: true,
            });
          }
          return;
        }
        if (tokenIsExpired(token)) return;
        const sessionEndpoint = configuredSessionEndpoint();
        await coordinator.runExclusive({
          kind: "passive-mirror",
          ...expectedOptions(expected),
          work: async (authority) => {
            authority.revalidate();
            if (consumeStewardServerCookieSynced(token, sessionEndpoint)) {
              lastSyncedAuthority.current = authority.revalidate();
              return;
            }
            const last = lastSyncedAuthority.current;
            if (
              last?.token === expected.token &&
              last.generation === expected.generation &&
              last.scope === expected.scope
            )
              return;

            // Account-link/Telegram claim authority never belongs to a passive
            // mirror; only the explicit, previewed confirmation may carry it.
            const res = await fetch(sessionEndpoint, {
              method: "POST",
              credentials: "include",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ token }),
              signal: authority.signal,
            });
            authority.revalidate();
            if (res.ok) {
              lastSyncedAuthority.current = authority.revalidate();
              dispatchStewardSessionChange("present");
              window.dispatchEvent(
                new CustomEvent("steward-token-sync", {
                  detail: { token, userId: user?.id },
                }),
              );
              return;
            }

            const body = await parseStewardResponseBody(res);
            authority.revalidate();
            if (body?.code === "server_secret_missing") {
              reportRendererDiagnostic({
                scope: "steward.server-secret-missing",
                error: new Error("Steward server secret is not configured"),
                severity: "warning",
              });
              return;
            }
            if (res.status !== 401) {
              reportRendererDiagnostic({
                scope: "steward.session-token-rejected",
                error: new Error("Server did not accept the stored token"),
                severity: "warning",
                context: { status: res.status, code: body?.code },
              });
              return;
            }
            if (body?.code === "session_ended") {
              // Only this documented session-sync boundary makes an explicit
              // paired-origin logout definitive even for an unexpired bearer.
              reportRendererDiagnostic({
                scope: "steward.session-ended",
                error: new Error("Session was ended by an explicit logout"),
                severity: "warning",
              });
              await clearStaleStewardSession({ authority });
              lastSyncedAuthority.current = null;
              return;
            }
            const current = readStoredToken();
            if (current && !tokenIsExpired(current)) {
              // A bare 401 from a stale/misrouted proxy is not revocation.
              // Do not dedupe a failed POST: the next visibility/storage
              // trigger must be able to retry the same current authority.
              lastSyncedAuthority.current = null;
              reportRendererDiagnostic({
                scope: "steward.session-sync-stale-proxy",
                error: new Error(
                  "Session sync returned 401 for a still-valid stored token",
                ),
                severity: "warning",
              });
              return;
            }
            reportRendererDiagnostic({
              scope: "steward.session-token-cleared",
              error: new Error("Stored token was rejected by the server"),
              severity: "warning",
            });
            await clearStaleStewardSession({ authority });
            lastSyncedAuthority.current = null;
          },
        });
      } catch (error) {
        // error-policy:J4 background synchronization failure is diagnosed, not
        // published as success or used to clear another context's authority.
        reportFailure("steward.session-cookie-sync", error);
      }
    };

    const checkAndRefresh = async (force = false): Promise<void> => {
      if (hidden || lifecycle.signal.aborted) return;
      const owner = lifecycle;
      let expected: StewardSessionAuthoritySnapshot;
      try {
        expected = coordinator.readSnapshot();
        const token = readStoredToken();
        if (!token) return;
        if (!force) {
          const secs = tokenSecsRemaining(token);
          if (secs !== null && secs >= REFRESH_AHEAD_SECS) return;
        }
      } catch (error) {
        // error-policy:J4 unavailable authority prevents refresh, not logout.
        reportFailure("steward.auto-refresh", error);
        return;
      }
      if (refreshInFlight) {
        if (refreshOwner === owner) return refreshInFlight;
        await refreshInFlight;
        if (hidden || owner !== lifecycle || owner.signal.aborted) return;
        return checkAndRefresh(force);
      }
      const pending = (async () => {
        try {
          await coordinator.runExclusive({
            kind: "refresh",
            ...expectedOptions(expected),
            work: async (authority) => {
              authority.revalidate();
              const res = await fetch(configuredRefreshEndpoint(), {
                method: "POST",
                credentials: "include",
                headers: {
                  "Content-Type": "application/json",
                  "X-Eliza-CSRF": "1",
                },
                signal: authority.signal,
              });
              authority.revalidate();
              if (res.ok) {
                const body = await parseStewardResponseBody(res);
                authority.revalidate();
                if (body?.token) {
                  await writeStoredStewardToken(body.token, { authority });
                  lastSyncedAuthority.current = authority.revalidate();
                }
                try {
                  window.dispatchEvent(new CustomEvent("steward-token-sync"));
                } catch (error) {
                  // error-policy:J7 a notification failure does not undo durable
                  // persistence; report it without inventing another session.
                  reportRendererDiagnostic({
                    scope: "steward.token-sync-event",
                    error,
                    severity: "warning",
                  });
                }
                return;
              }
              if (res.status === 401) {
                // Preserve the current refresh boundary's stale-proxy policy:
                // unlike session-sync's documented session_ended response, a
                // bare refresh 401 cannot invalidate a still-valid bearer.
                const current = readStoredToken();
                if (!current || tokenIsExpired(current)) {
                  await clearStaleStewardSession({ authority });
                  lastSyncedAuthority.current = null;
                } else {
                  reportRendererDiagnostic({
                    scope: "steward.refresh-stale-proxy",
                    error: new Error(
                      "Refresh returned 401 for a still-valid stored token",
                    ),
                    severity: "warning",
                  });
                }
              }
            },
          });
        } catch (error) {
          // error-policy:J4 transient refresh failure retains the current
          // session, while stale/cancelled work cannot publish a replacement.
          reportFailure("steward.auto-refresh", error);
        }
      })().finally(() => {
        if (refreshInFlight === pending) {
          refreshInFlight = null;
          refreshOwner = null;
        }
      });
      refreshInFlight = pending;
      refreshOwner = owner;
      return pending;
    };

    void syncToken();
    void checkAndRefresh();
    const refreshInterval = setInterval(() => {
      void checkAndRefresh();
    }, REFRESH_CHECK_INTERVAL_MS);
    const handler = () => {
      void syncToken();
    };
    window.addEventListener("storage", handler);
    const visibilityHandler = () => {
      if (document.visibilityState === "visible") {
        void syncToken();
        void checkAndRefresh();
      }
    };
    document.addEventListener("visibilitychange", visibilityHandler);
    const onlineHandler = () => {
      void checkAndRefresh();
    };
    window.addEventListener("online", onlineHandler);
    const unauthorizedHandler = () => {
      void checkAndRefresh(true);
    };
    window.addEventListener("steward-unauthorized", unauthorizedHandler);
    const hide = () => {
      hidden = true;
      lifecycle.abort();
      lastSyncedAuthority.current = null;
    };
    const show = () => {
      if (!hidden) return;
      hidden = false;
      lifecycle = new AbortController();
      void syncToken();
      void checkAndRefresh();
    };
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);

    return () => {
      lifecycle.abort();
      clearInterval(refreshInterval);
      window.removeEventListener("storage", handler);
      document.removeEventListener("visibilitychange", visibilityHandler);
      window.removeEventListener("online", onlineHandler);
      window.removeEventListener("steward-unauthorized", unauthorizedHandler);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, [isAuthenticated, user]);

  // Map the SDK context to the local context shape explicitly. The structural
  // pass-through is fragile across @elizaos/login resolutions; verifyEmailCallback
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
        // Retire explicit-sync proof before the SDK begins its own fallible
        // sign-out work. A same-token login after any partial teardown must
        // establish the local server cookie again.
        invalidateStewardServerCookieSyncMarker();
        // Drop the at-rest JWT from the persisted active server before the SDK
        // sign-out — leaving it in localStorage is an at-rest token leak. Keeps
        // the backend selection (kind/apiBase) so re-auth lands on the same one.
        // The same JWT is also copied into the per-agent profile records, so
        // scrub those too — otherwise the token survives at rest there.
        scrubPersistedActiveServerToken();
        scrubPersistedAgentProfileTokens();
        return auth.signOut();
      },
      getToken: () => auth.getToken(),
      verifyEmailCallback: async (
        token: string,
        email: string,
        authoritySnapshot?: StewardSessionAuthoritySnapshot,
        signal?: AbortSignal,
        beforeSessionCommit?: Parameters<
          LocalStewardAuthValue["verifyEmailCallback"]
        >[4],
      ) => {
        const coordinator = getStewardTabSessionAuthorityCoordinator();
        const expected = authoritySnapshot ?? coordinator.readSnapshot();
        const result = await auth.verifyEmailCallback(token, email, {
          signal,
          // Verify the one-time proof outside the lock; publish SDK authority
          // only if that original invocation still owns the origin afterward.
          commitSession: (commit, candidate, sessionSignal) =>
            coordinator.runExclusive({
              kind: "callback-restore",
              expectedToken: expected.token,
              expectedGeneration: expected.generation,
              expectedScope: expected.scope,
              signal: sessionSignal,
              work: async (authority) => {
                authority.revalidate();
                if (beforeSessionCommit && !candidate.mfaRequired) {
                  if (!candidate.token)
                    throw new Error(
                      "Auth response did not include a session token",
                    );
                  await beforeSessionCommit(
                    {
                      token: candidate.token,
                      refreshToken: candidate.refreshToken,
                    },
                    authority,
                  );
                  authority.revalidate();
                }
                const result = await commit();
                authority.revalidate();
                return result;
              },
            }),
        });
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
      new LoginClient({
        baseUrl: apiUrl,
        ...(tenantId && !isPlaceholderValue(tenantId) ? { tenantId } : {}),
      }),
    [apiUrl, tenantId],
  );
  const authConfig = useMemo(() => ({ baseUrl: apiUrl }), [apiUrl]);
  const authInstance = useRuntimeAuthOwner(
    apiUrl,
    tenantId && !isPlaceholderValue(tenantId) ? tenantId : undefined,
  );

  return (
    <LoginProvider
      client={client}
      agentId="eliza-cloud"
      theme={ELIZA_STEWARD_THEME}
      auth={authConfig}
      authInstance={authInstance}
      tenantId={
        tenantId && !isPlaceholderValue(tenantId) ? tenantId : undefined
      }
    >
      <AuthTokenSync>{children}</AuthTokenSync>
    </LoginProvider>
  );
}
