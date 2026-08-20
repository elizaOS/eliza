/**
 * useAuthStatus — monitors the current auth state via GET /api/auth/me.
 *
 * Returns a discriminated union that lets the shell decide whether to render
 * the login gate or the main dashboard.
 *
 * The initial probe fails closed: network errors become server-unavailable so
 * the app never paints a protected shell before auth is known. Background and
 * visibility revalidation keep the last resolved state until the new result
 * arrives; briefly publishing `loading` there would tear down the live shell.
 *
 * Call `refetch()` after login / logout to force a fresh check.
 *
 * Startup can overlap the probe with the backend polling/hydration phases via
 * `primeAuthStatusProbe()`; the hook's activation then reuses that in-flight /
 * fresh result instead of serializing a new probe after first paint.
 */

import {
  STEWARD_SESSION_CHANGE_EVENT,
  STEWARD_TOKEN_KEY,
} from "@elizaos/shared/steward-session-client";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type AuthAccessInfo,
  type AuthIdentity,
  type AuthSessionInfo,
  authMe,
} from "../api/auth-client";
import { getBootConfig, setBootConfig } from "../config/boot-config-store";
import { scrubRejectedActiveServerCredential } from "../state/active-server-credential";
import { scrubPersistedAgentProfileTokens } from "../state/agent-profiles";
import { loadPersistedActiveServer } from "../state/persistence";
import { isPrivateNetworkHost } from "../state/private-network-host";
import { clearSharedCloudAccountBinding } from "../state/shared-cloud-account-binding";
import { isManagedCloudSharedAgentBase } from "../utils/cloud-agent-base";

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
// is authoritative in the activated hook. The startup prime has one narrower
// private-runtime exception documented at `primeAuthStatusProbe`.
const SERVER_UNAVAILABLE_RETRIES = 10;
const SERVER_UNAVAILABLE_RETRY_MS = 1000;
const authStatusSubscribers = new Set<(state: AuthStatusState) => void>();
let authStatusSnapshot: AuthStatusState = { phase: "loading" };
let authStatusFetch: Promise<void> | null = null;
let authStatusPrime: Promise<void> | null = null;
let authStatusPrimeSettledAt = 0;
let authStatusEpoch = 0;
// A primed result is only trusted by the activation path for a boot-scale
// window; a hook that (re)activates later re-probes exactly as before, so a
// stale prime can never stand in for the session's current auth state.
const AUTH_STATUS_PRIME_FRESH_MS = 30_000;

function publishAuthStatus(state: AuthStatusState): void {
  authStatusSnapshot = state;
  for (const subscriber of authStatusSubscribers) {
    subscriber(state);
  }
}

async function authMeWithRejectedBearerRecovery(
  initialResult?: Awaited<ReturnType<typeof authMe>>,
) {
  const result = initialResult ?? (await authMe());
  if (result.ok || result.status !== 401 || result.access?.mode !== "remote") {
    return result;
  }

  const apiToken = getBootConfig().apiToken?.trim();
  const activeServer = loadPersistedActiveServer();
  if (!apiToken || activeServer?.kind === "cloud") return result;

  // A 401 makes this bearer definitively unusable for the selected non-cloud
  // target. Remove it before the one retry so a valid cookie can win, or the
  // server can return the unauthenticated pairing/password contract instead of
  // seeing the same rejected Authorization header twice.
  setBootConfig({ ...getBootConfig(), apiToken: undefined });
  scrubRejectedActiveServerCredential(apiToken);
  return authMe();
}

function shouldDeferPrimedPrivateRuntimeRejection(
  result: Awaited<ReturnType<typeof authMe>>,
): boolean {
  if (result.ok || result.status !== 401 || result.access?.mode !== "remote") {
    return false;
  }
  if (!getBootConfig().apiToken?.trim()) return false;

  const activeServer = loadPersistedActiveServer();
  if (activeServer?.kind !== "remote" || !activeServer.apiBase) return false;
  try {
    return isPrivateNetworkHost(new URL(activeServer.apiBase).hostname);
  } catch {
    // error-policy:J3 an unparseable target cannot qualify for the private
    // runtime startup grace path, so normal fail-closed rejection owns it.
    return false;
  }
}

async function fetchAuthStatus(): Promise<void> {
  if (authStatusFetch) return authStatusFetch;

  // The shared snapshot already starts in `loading`, so the cold probe remains
  // fail-closed. Once resolved, revalidation is stale-while-revalidate: the
  // backend still enforces auth while the UI retains its mounted shell until an
  // authoritative authenticated/unauthenticated/unavailable result arrives.

  const probeEpoch = authStatusEpoch;
  authStatusFetch = (async () => {
    for (let attempt = 0; ; attempt += 1) {
      const result = await authMeWithRejectedBearerRecovery();
      if (probeEpoch !== authStatusEpoch) return;
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
        // A cloud Steward-refresh outage/throttle is not the local-agent boot
        // race this retry budget exists for; each retry would re-POST the
        // refresh endpoint and amplify a 429. Surface unavailability at once.
        if (result.reason === "cloud_unavailable") {
          publishAuthStatus({ phase: "server_unavailable" });
          return;
        }
        if (attempt < SERVER_UNAVAILABLE_RETRIES) {
          await new Promise((resolve) =>
            setTimeout(resolve, SERVER_UNAVAILABLE_RETRY_MS),
          );
          if (probeEpoch !== authStatusEpoch) return;
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
 * Start the `/api/auth/me` probe early — during startup's restoring-session
 * phase, right after the restored connection is applied to the client — so it
 * overlaps the backend polling/hydration phases instead of serializing after
 * the shell becomes paintable (App.tsx's `useAuthStatus` skips until then).
 *
 * Only outcomes stable across the boot race are published into the shared
 * snapshot. Authenticated and ordinary unauthenticated results are stable. A
 * 503/unreachable result and the first bearer-backed 401 from a private remote
 * runtime are discarded because its listener can bind before startup restores
 * auth authority. The hook's activation fetch re-probes after startup; a
 * repeated 401 then follows the normal credential-scrub and login contract.
 *
 * Fire-and-forget and single-shot: repeat calls, an in-flight real fetch, or
 * an already-resolved snapshot make it a no-op.
 */
export function primeAuthStatusProbe(): void {
  if (authStatusPrime || authStatusFetch) return;
  if (authStatusSnapshot.phase !== "loading") return;
  const probeEpoch = authStatusEpoch;
  authStatusPrime = (async () => {
    const firstResult = await authMe();
    if (probeEpoch !== authStatusEpoch) return;
    // A private runtime can bind its listener before bearer/session authority
    // finishes restoring. Do not erase a persisted device credential from that
    // one boot-overlap response: activation will re-probe after startup. A
    // second 401 still takes the ordinary scrub + unauthenticated path.
    if (shouldDeferPrimedPrivateRuntimeRejection(firstResult)) return;
    const result =
      firstResult.ok ||
      firstResult.status !== 401 ||
      firstResult.access?.mode !== "remote"
        ? firstResult
        : await authMeWithRejectedBearerRecovery(firstResult);
    if (probeEpoch !== authStatusEpoch) return;
    // A real fetch started (or a state was published) while the prime was in
    // flight — that path owns the snapshot; drop the primed result.
    if (authStatusFetch || authStatusSnapshot.phase !== "loading") return;
    if (result.ok === true) {
      publishAuthStatus({
        phase: "authenticated",
        identity: result.identity,
        session: result.session,
        access: result.access,
      });
      return;
    }
    if (result.status === 503) return;
    publishAuthStatus({
      phase: "unauthenticated",
      reason:
        result.reason === "remote_auth_required" ||
        result.reason === "remote_password_not_configured"
          ? result.reason
          : undefined,
      access: result.access,
    });
  })().finally(() => {
    authStatusPrimeSettledAt = Date.now();
  });
}

/**
 * Activation-path fetch: joins an in-flight probe, accepts a fresh primed
 * terminal result (so a boot primed by {@link primeAuthStatusProbe} does not
 * throw the answer away and re-hold the shell on `loading`), and otherwise
 * fetches exactly like the pre-prime behavior. `refetch()` deliberately does
 * NOT come through here — login/logout/visibility re-checks must always force
 * a real probe.
 */
async function ensureAuthStatusProbe(): Promise<void> {
  if (authStatusFetch) return authStatusFetch;
  if (authStatusPrime) {
    await authStatusPrime;
    const fresh =
      Date.now() - authStatusPrimeSettledAt <= AUTH_STATUS_PRIME_FRESH_MS;
    if (
      fresh &&
      (authStatusSnapshot.phase === "authenticated" ||
        authStatusSnapshot.phase === "unauthenticated")
    ) {
      return;
    }
  }
  return fetchAuthStatus();
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
 * Non-hook read of the shared auth snapshot's authenticated state, for module
 * seams (stores/services) that gate on auth without a React context — e.g. the
 * notification store holding its protected hydrate until a session exists
 * (#16242). Mirrors {@link useIsAuthenticated} without subscribing.
 */
export function isAuthenticatedNow(): boolean {
  return authStatusSnapshot.phase === "authenticated";
}

/**
 * Non-hook read of the full shared auth-status snapshot, for module seams
 * that need the resolved identity/session (not just the authenticated
 * boolean) to key state per authority — e.g. the notification store
 * isolating its inbox per user/agent (#18391). Mirrors {@link isAuthenticatedNow}.
 */
export function getAuthStatusSnapshot(): AuthStatusState {
  return authStatusSnapshot;
}

/**
 * Subscribe to auth-status changes outside React (companion to
 * {@link isAuthenticatedNow}). The listener fires on every publish with the new
 * snapshot; returns an unsubscribe. Lets a module seam re-arm work it deferred
 * while unauthenticated the moment a session lands.
 */
export function subscribeAuthStatus(
  listener: (state: AuthStatusState) => void,
): () => void {
  authStatusSubscribers.add(listener);
  return () => {
    authStatusSubscribers.delete(listener);
  };
}

/** Force the shared auth probe to run now and publish its resolved state. */
export function revalidateAuthStatus(): Promise<void> {
  return fetchAuthStatus();
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

/**
 * Test-only companion to {@link __setAuthStatusForTests}: reset the
 * module-level probe state (snapshot, in-flight fetch, prime) between tests
 * so shared-singleton auth state cannot leak across cases. Never call from
 * product code.
 */
export function __resetAuthStatusForTests(): void {
  authStatusFetch = null;
  authStatusPrime = null;
  authStatusPrimeSettledAt = 0;
  authStatusEpoch += 1;
  publishAuthStatus({ phase: "loading" });
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

  // Activation consumes a fresh startup prime instead of unconditionally
  // re-probing; every other trigger (refetch, poll, visibility) still forces
  // a real fetch via `fetch` above.
  const activate = useCallback(async () => {
    if (!mountedRef.current) return;
    await ensureAuthStatusProbe();
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    authStatusSubscribers.add(setState);
    setState(authStatusSnapshot);
    if (!skip && !observeOnly) void activate();
    return () => {
      mountedRef.current = false;
      authStatusSubscribers.delete(setState);
    };
  }, [skip, observeOnly, activate]);

  useEffect(() => {
    if (skip || observeOnly) return;

    const stewardSessionHandler = (event: Event) => {
      const detail = (event as CustomEvent<{ state?: string }>).detail;
      if (detail?.state === "cleared") {
        if (isManagedCloudSharedAgentBase(getBootConfig().apiBase)) {
          // Any auth request started under the ending account is no longer
          // authoritative and must not overwrite the terminal state below.
          authStatusEpoch += 1;
          clearSharedCloudAccountBinding();
          scrubPersistedAgentProfileTokens();
          // The shared runtime has no independent agent session: terminal
          // Steward expiry is authoritative immediately. Publishing here
          // unmounts every useIsAuthenticated-gated poller and moves the shell
          // to Cloud reauthentication instead of waiting for the five-minute
          // auth poll while protected requests loop on 401.
          const {
            apiBase: _apiBase,
            apiToken: _apiToken,
            ...accountConfig
          } = getBootConfig();
          setBootConfig(accountConfig);
          publishAuthStatus({
            phase: "unauthenticated",
            reason: "remote_auth_required",
            access: {
              mode: "remote",
              passwordConfigured: false,
              ownerConfigured: true,
            },
          });
        }
        return;
      }
      // A new Steward session may have landed after reauthentication. Only
      // re-probe when an account-scoped target is already bound; terminal
      // shared-session cleanup deliberately removed the old account's target,
      // and authenticating against its in-memory base before agent selection
      // would remount stale chat. Full-page SSO reload or onboarding owns the
      // targetless account-resolution path.
      if (loadPersistedActiveServer()) void fetch();
    };
    window.addEventListener(
      STEWARD_SESSION_CHANGE_EVENT,
      stewardSessionHandler,
    );
    const stewardStorageHandler = (event: StorageEvent) => {
      if (event.key !== STEWARD_TOKEN_KEY) return;
      stewardSessionHandler(
        new CustomEvent(STEWARD_SESSION_CHANGE_EVENT, {
          detail: { state: event.newValue ? "present" : "cleared" },
        }),
      );
    };
    window.addEventListener("storage", stewardStorageHandler);
    const stewardTokenSyncHandler = () => {
      if (isManagedCloudSharedAgentBase(getBootConfig().apiBase)) void fetch();
    };
    window.addEventListener("steward-token-sync", stewardTokenSyncHandler);

    const id =
      pollIntervalMs === 0
        ? null
        : setInterval(() => {
            if (
              typeof document !== "undefined" &&
              document.visibilityState === "hidden"
            ) {
              return;
            }
            void fetch();
          }, pollIntervalMs);

    const visibilityHandler =
      pollIntervalMs !== 0 && typeof document !== "undefined"
        ? () => {
            if (document.visibilityState === "visible") void fetch();
          }
        : undefined;
    if (visibilityHandler) {
      document.addEventListener("visibilitychange", visibilityHandler);
    }

    return () => {
      window.removeEventListener(
        STEWARD_SESSION_CHANGE_EVENT,
        stewardSessionHandler,
      );
      window.removeEventListener("storage", stewardStorageHandler);
      window.removeEventListener("steward-token-sync", stewardTokenSyncHandler);
      if (id !== null) clearInterval(id);
      if (visibilityHandler && typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", visibilityHandler);
      }
    };
  }, [skip, observeOnly, pollIntervalMs, fetch]);

  return { state, refetch: fetch };
}
