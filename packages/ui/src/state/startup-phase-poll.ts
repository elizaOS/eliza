/**
 * startup-phase-poll.ts
 *
 * Side-effect logic for the "polling-backend" startup phase.
 * Polls the backend until it responds, then dispatches BACKEND_REACHED
 * or an appropriate error/auth event.
 */

import { logger } from "@elizaos/core";
import { getStylePresets } from "@elizaos/shared";
import type { FirstRunOptions } from "../api";
import { client } from "../api";
import { getBackendStartupTimeoutMs, scanProviderCredentials } from "../bridge";
import type { FirstRunRuntimeTarget } from "../first-run/runtime-target";
import type { UiLanguage } from "../i18n";
import { isAndroid, isIOS } from "../platform";
import {
  asApiLikeError,
  clearPersistedSetupStep,
  deriveFirstRunResumeFieldsFromConfig,
  formatStartupErrorDetail,
  inferSetupResumeStep,
  type StartupErrorState,
} from "./internal";
import {
  clearPersistedActiveServer,
  loadPersistedSetupStep,
  savePersistedActiveServer,
} from "./persistence";
import type { PlatformPolicy, StartupEvent } from "./startup-coordinator";
import type { RestoringSessionCtx } from "./startup-phase-restore";
import type { SetupStep } from "./types";

function isCapacitorNative(): boolean {
  try {
    const cap = (globalThis as Record<string, unknown>).Capacitor as
      | { isNativePlatform?: () => boolean }
      | undefined;
    return Boolean(cap?.isNativePlatform?.());
  } catch {
    return false;
  }
}

/**
 * Decide whether a connection-level startup failure against the persisted
 * active server should be abandoned in favour of the local same-origin backend
 * that is actually serving this page.
 *
 * This rescues first-run from a stale `elizaos:active-server` pointing at a
 * remote/cloud backend that is now unreachable or CSP-blocked: without it the
 * poll loop retries the dead address until BACKEND_TIMEOUT and the app wedges
 * forever, with no way to reach onboarding and pick a working server.
 *
 * It fires ONLY when every one of these holds, so it can't hijack a legitimate
 * remote/mobile session:
 *  - the failure is connection-level — the request never received an HTTP
 *    response (a 401/404/5xx means the server answered, so it isn't a
 *    connectivity wedge and has its own handling);
 *  - the client is currently pinned to a non-loopback base that isn't this
 *    page's own origin (so there is a remote to fall back *from* — loopback
 *    bases are the local agent, reconciled elsewhere);
 *  - the page is served over http(s) (a real local backend exists to fall back
 *    *to*, same-origin). Native mobile, where the remote IS the agent, is
 *    excluded via `isNativeMobile`.
 */
export function shouldFallBackToLocalOrigin(args: {
  error: unknown;
  clientBaseUrl: string;
  pageOrigin: string | null;
  pageProtocol: string | null;
  isNativeMobile: boolean;
}): boolean {
  // A structured HTTP status means the server responded — not a wedge.
  if (typeof asApiLikeError(args.error)?.status === "number") return false;
  return isRecoverableRemoteBase(args);
}

/**
 * True when the client is currently pinned to a base we could abandon in favour
 * of the local same-origin backend: a non-empty, non-loopback host that isn't
 * this page's own origin, on an http(s) page, and not native mobile (where the
 * remote IS the agent). This is the location half of the recovery checks —
 * {@link shouldFallBackToLocalOrigin} adds the connection-level-error condition,
 * while the auth-required dead-end path adds a pairing-disabled condition.
 */
export function isRecoverableRemoteBase(args: {
  clientBaseUrl: string;
  pageOrigin: string | null;
  pageProtocol: string | null;
  isNativeMobile: boolean;
  /**
   * Allow recovering from a loopback base that is NOT this page's origin.
   * The connection-error path leaves loopback alone (a loopback that won't
   * connect is the local agent still booting). The auth-walled path passes
   * true: a loopback agent that *answered* with a pairing-disabled gate is a
   * real dead end — e.g. dev-in-browser pinned to the agent's raw port
   * (127.0.0.1:31337) which the agent 401s as a cross-origin request, while
   * the same-origin proxy serving this page reaches it with localAccess.
   */
  allowLoopback?: boolean;
}): boolean {
  if (args.isNativeMobile) return false;
  if (args.pageProtocol !== "http:" && args.pageProtocol !== "https:") {
    return false;
  }
  const base = args.clientBaseUrl.trim();
  if (!base) return false; // already same-origin / local
  try {
    const url = new URL(base);
    // Never recover to where we already are (no pointless self-recovery loop).
    if (args.pageOrigin && url.origin === args.pageOrigin) return false;
    if (!args.allowLoopback) {
      const host = url.hostname.toLowerCase();
      if (host === "127.0.0.1" || host === "localhost" || host === "::1") {
        return false;
      }
    }
  } catch {
    return false;
  }
  return true;
}

export interface PollingBackendDeps {
  setStartupError: (v: StartupErrorState | null) => void;
  setAuthRequired: (v: boolean) => void;
  setFirstRunComplete: (v: boolean) => void;
  setFirstRunLoading: (v: boolean) => void;
  setFirstRunOptions: (v: FirstRunOptions) => void;
  setSetupStep: (v: SetupStep) => void;
  setFirstRunRuntimeTarget: (v: FirstRunRuntimeTarget) => void;
  setFirstRunCloudApiKey: (v: string) => void;
  setFirstRunProvider: (v: string) => void;
  setFirstRunVoiceProvider: (v: string) => void;
  setFirstRunApiKey: (v: string) => void;
  setFirstRunPrimaryModel: (v: string) => void;
  setFirstRunOpenRouterModel: (v: string) => void;
  setFirstRunRemoteConnected: (v: boolean) => void;
  setFirstRunRemoteApiBase: (v: string) => void;
  setFirstRunRemoteToken: (v: string) => void;
  setFirstRunSmallModel: (v: string) => void;
  setFirstRunLargeModel: (v: string) => void;
  setFirstRunCloudProvisionedContainer: (v: boolean) => void;
  setPairingEnabled: (v: boolean) => void;
  setPairingExpiresAt: (v: number | null) => void;
  applyDetectedProviders: (
    detected: Awaited<ReturnType<typeof scanProviderCredentials>>,
  ) => void;
  firstRunCompletionCommittedRef: React.MutableRefObject<boolean>;
  uiLanguage: UiLanguage;
}

/** Apply resume fields derived from a partial config to the first-run state. */
function applyFirstRunResumeFields(
  rf: ReturnType<typeof deriveFirstRunResumeFieldsFromConfig>,
  deps: Pick<
    PollingBackendDeps,
    | "setFirstRunRuntimeTarget"
    | "setFirstRunCloudApiKey"
    | "setFirstRunProvider"
    | "setFirstRunVoiceProvider"
    | "setFirstRunApiKey"
    | "setFirstRunPrimaryModel"
    | "setFirstRunOpenRouterModel"
    | "setFirstRunRemoteConnected"
    | "setFirstRunRemoteApiBase"
    | "setFirstRunRemoteToken"
    | "setFirstRunSmallModel"
    | "setFirstRunLargeModel"
  >,
): void {
  if (rf.firstRunRuntimeTarget !== undefined)
    deps.setFirstRunRuntimeTarget(rf.firstRunRuntimeTarget);
  if (rf.firstRunCloudApiKey !== undefined)
    deps.setFirstRunCloudApiKey(rf.firstRunCloudApiKey);
  if (rf.firstRunProvider !== undefined)
    deps.setFirstRunProvider(rf.firstRunProvider);
  if (rf.firstRunVoiceProvider !== undefined)
    deps.setFirstRunVoiceProvider(rf.firstRunVoiceProvider);
  if (rf.firstRunApiKey !== undefined)
    deps.setFirstRunApiKey(rf.firstRunApiKey);
  if (rf.firstRunPrimaryModel !== undefined)
    deps.setFirstRunPrimaryModel(rf.firstRunPrimaryModel);
  if (rf.firstRunOpenRouterModel !== undefined)
    deps.setFirstRunOpenRouterModel(rf.firstRunOpenRouterModel);
  if (rf.firstRunRemoteConnected !== undefined)
    deps.setFirstRunRemoteConnected(rf.firstRunRemoteConnected);
  if (rf.firstRunRemoteApiBase !== undefined)
    deps.setFirstRunRemoteApiBase(rf.firstRunRemoteApiBase);
  if (rf.firstRunRemoteToken !== undefined)
    deps.setFirstRunRemoteToken(rf.firstRunRemoteToken);
  if (rf.firstRunSmallModel !== undefined)
    deps.setFirstRunSmallModel(rf.firstRunSmallModel);
  if (rf.firstRunLargeModel !== undefined)
    deps.setFirstRunLargeModel(rf.firstRunLargeModel);
}

/**
 * Runs the polling-backend phase.
 * Polls /auth/status and /first-run/status until the backend is reachable
 * and first-run state is determined.
 *
 * @param deps - Coordinator dependency bag
 * @param dispatch - startupReducer dispatch
 * @param policy - Platform policy (timeout etc.)
 * @param ctx - Session context populated by the restoring-session phase
 * @param effectRunId - The run ID of the calling effect (for stale-close guard)
 * @param effectRunRef - Shared ref tracking the latest run ID
 * @param cancelled - Ref-flag set true by the cleanup function
 * @param tidRef - Mutable ref for the pending setTimeout handle (for cleanup)
 */
export async function runPollingBackend(
  deps: PollingBackendDeps,
  dispatch: (event: StartupEvent) => void,
  policy: PlatformPolicy,
  ctx: RestoringSessionCtx | null,
  effectRunId: number,
  effectRunRef: React.MutableRefObject<number>,
  cancelled: { current: boolean },
  tidRef: { current: ReturnType<typeof setTimeout> | null },
): Promise<void> {
  const describeBackendFailure = (
    err: unknown,
    timedOut: boolean,
  ): StartupErrorState => {
    const apiErr = asApiLikeError(err);
    if (apiErr?.kind === "http" && apiErr.status === 404)
      return {
        reason: "backend-unreachable",
        phase: "starting-backend",
        message:
          "Backend API routes are unavailable on this origin (received 404).",
        detail: formatStartupErrorDetail(err),
        status: apiErr.status,
        path: apiErr.path,
      };
    if (timedOut || apiErr?.kind === "timeout")
      return {
        reason: "backend-timeout",
        phase: "starting-backend",
        message: `Backend did not become reachable within ${Math.round(getBackendStartupTimeoutMs() / 1000)}s.`,
        detail: formatStartupErrorDetail(err),
        status: apiErr?.status,
        path: apiErr?.path,
      };
    return {
      reason: "backend-unreachable",
      phase: "starting-backend",
      message: "Failed to reach backend during startup.",
      detail: formatStartupErrorDetail(err),
      status: apiErr?.status,
      path: apiErr?.path,
    };
  };

  let deadline = Date.now() + policy.backendTimeoutMs;
  let attempts = 0;
  let lastErr: unknown = null;
  // Guards a one-shot recovery: if the saved server is unreachable we clear it
  // and re-point the client at the local origin exactly once, never in a loop.
  let fellBackToLocal = false;
  let latestAuth: Awaited<ReturnType<typeof client.getAuthStatus>> = {
    required: false,
    pairingEnabled: false,
    expiresAt: null as number | null,
  };

  const recoveryEnv = () => ({
    clientBaseUrl: client.getBaseUrl(),
    pageOrigin: typeof window !== "undefined" ? window.location.origin : null,
    pageProtocol:
      typeof window !== "undefined" ? window.location.protocol : null,
    isNativeMobile: isCapacitorNative() || isAndroid || isIOS,
  });

  // One-shot: clear the stale saved server, re-point at the local origin, and
  // reset the budget so the loop re-polls localhost. Used both when the saved
  // server is unreachable and when it dead-ends on an unpassable auth gate.
  const recoverToLocalOrigin = (why: string) => {
    fellBackToLocal = true;
    logger.warn(
      { staleBase: client.getBaseUrl(), reason: why },
      "[startup-phase-poll] abandoning the saved server; falling back to the local origin",
    );
    clearPersistedActiveServer();
    client.setBaseUrl(null);
    client.setToken(null);
    deadline = Date.now() + policy.backendTimeoutMs;
    attempts = 0;
    lastErr = null;
  };

  while (!cancelled.current && effectRunRef.current === effectRunId) {
    if (Date.now() >= deadline) {
      deps.setStartupError(describeBackendFailure(lastErr, true));
      deps.setFirstRunLoading(false);
      dispatch({ type: "BACKEND_TIMEOUT" });
      return;
    }
    try {
      const auth = await client.getAuthStatus();
      latestAuth = auth;
      if (cancelled.current) return;
      if (auth.required && !auth.authenticated && !client.hasToken()) {
        if (auth.bootstrapRequired) {
          deps.setAuthRequired(false);
          deps.setFirstRunCloudProvisionedContainer(true);
          deps.setFirstRunComplete(false);
          deps.setFirstRunLoading(false);
          dispatch({ type: "BACKEND_REACHED", firstRunComplete: false });
          return;
        }
        // A stale remote that requires auth but has pairing DISABLED is a hard
        // dead end: this is the "Pairing is not enabled on this server" screen,
        // which offers no token field and no in-app way forward — the user can
        // neither pair nor sign in here. We only reach this branch with no token
        // (see the !hasToken guard above), so there is genuinely nothing the
        // user can do on this server. Recover to the local origin instead of
        // stranding them, whether or not they completed a prior first-run — a
        // returning user who lost their token re-connects through onboarding,
        // which is strictly better than a wall. allowLoopback: a base pinned at
        // the agent's raw loopback port (e.g. dev-in-browser at 127.0.0.1:31337)
        // 401s the browser cross-origin and lands here too — recover to the
        // same-origin proxy that serves this page. `isRecoverableRemoteBase`
        // still refuses to recover to the page's own origin (no self-loop), and
        // pairing-ENABLED remotes keep the pairing gate so users can pair.
        if (
          !fellBackToLocal &&
          !auth.pairingEnabled &&
          isRecoverableRemoteBase({ ...recoveryEnv(), allowLoopback: true })
        ) {
          recoverToLocalOrigin(
            "saved remote requires auth but pairing is disabled (dead end)",
          );
          continue;
        }
        deps.setAuthRequired(true);
        deps.setPairingEnabled(auth.pairingEnabled);
        deps.setPairingExpiresAt(auth.expiresAt);
        deps.setFirstRunLoading(false);
        dispatch({ type: "BACKEND_AUTH_REQUIRED" });
        return;
      }
      // Token holder, but the server still says auth is required (e.g. the
      // remote owner password has not been set yet, so /api/auth/me will
      // return 401 with reason="remote_password_not_configured"). Don't
      // loop polling forever — advance the coordinator to "ready" so the
      // top-level auth gate can render LoginView with an actionable
      // "Remote access blocked" message. Without this, the phone is stuck
      // in startup because every first-run/runtime endpoint returns 401.
      if (auth.required && !auth.authenticated && client.hasToken()) {
        deps.setAuthRequired(false);
        deps.setFirstRunComplete(true);
        deps.setFirstRunLoading(false);
        dispatch({ type: "BACKEND_REACHED", firstRunComplete: true });
        return;
      }
      const firstRunStatusRes = await client.getFirstRunStatus();
      const { complete, cloudProvisioned } = firstRunStatusRes;
      if (cancelled.current) return;
      deps.setFirstRunCloudProvisionedContainer(Boolean(cloudProvisioned));
      let sessionComplete =
        complete || deps.firstRunCompletionCommittedRef.current;

      // Preserve backend-complete installs even when this browser has no prior
      // local state (for example headless/VPS setups or a fresh visit to a
      // cloud-provisioned container). Only clear the optimistic completion
      // flag when the backend itself still reports firstRun as incomplete.
      if (
        sessionComplete &&
        !complete &&
        !ctx?.persistedActiveServer &&
        !ctx?.hadPriorFirstRun
      ) {
        sessionComplete = false;
      }

      if (complete && sessionComplete) {
        clearPersistedSetupStep();
      }
      if (
        sessionComplete &&
        !ctx?.persistedActiveServer &&
        ctx?.restoredActiveServer
      ) {
        savePersistedActiveServer(ctx.restoredActiveServer);
      }
      deps.setFirstRunComplete(sessionComplete);

      if (!sessionComplete) {
        // Fetch first-run options
        const optDeadline = Date.now() + getBackendStartupTimeoutMs();
        let optErr: unknown = null;
        while (!cancelled.current && effectRunRef.current === effectRunId) {
          if (Date.now() >= optDeadline) {
            deps.setStartupError(describeBackendFailure(optErr, true));
            deps.setFirstRunLoading(false);
            dispatch({ type: "BACKEND_TIMEOUT" });
            return;
          }
          try {
            const [options, config] = await Promise.all([
              client.getFirstRunOptions(),
              client.getConfig().catch(() => null),
            ]);
            if (deps.firstRunCompletionCommittedRef.current) {
              deps.setFirstRunLoading(false);
              dispatch({ type: "FIRST_RUN_COMPLETE" });
              return;
            }
            const rf = deriveFirstRunResumeFieldsFromConfig(config);
            deps.setFirstRunOptions({
              ...options,
              styles:
                options.styles.length > 0
                  ? options.styles
                  : getStylePresets(deps.uiLanguage),
            });
            if (!rf.firstRunProvider) {
              try {
                const det = await scanProviderCredentials();
                if (det.length > 0) deps.applyDetectedProviders(det);
              } catch (error: unknown) {
                logger.warn(
                  { error },
                  "[startup-phase-poll] provider-credential scan failed during onboarding resume",
                );
              }
            }
            applyFirstRunResumeFields(rf, deps);
            deps.setSetupStep(
              inferSetupResumeStep({
                persistedStep: loadPersistedSetupStep(),
                config,
              }),
            );
            deps.setFirstRunLoading(false);
            dispatch({
              type: "BACKEND_REACHED",
              firstRunComplete: false,
            });
            return;
          } catch (err) {
            const ae = asApiLikeError(err);
            if (ae?.status === 401 && client.hasToken()) {
              // Transient 401: retry. /api/auth/status is the auth gate.
              optErr = err;
              await new Promise<void>((r) => {
                tidRef.current = setTimeout(r, 500);
              });
              continue;
            }
            if (ae?.status === 404) {
              deps.setStartupError(describeBackendFailure(err, false));
              deps.setFirstRunLoading(false);
              dispatch({ type: "BACKEND_NOT_FOUND" });
              return;
            }
            optErr = err;
            await new Promise<void>((r) => {
              tidRef.current = setTimeout(r, 500);
            });
          }
        }
        return;
      }
      dispatch({ type: "BACKEND_REACHED", firstRunComplete: true });
      return;
    } catch (err) {
      const ae = asApiLikeError(err);
      if (ae?.status === 401 && !client.hasToken()) {
        // On Capacitor native the bearer token is injected asynchronously by
        // the native Agent plugin after the WebView boots. The first poll can
        // fire before that injection completes, producing a spurious 401 even
        // though the agent is up and will accept the token momentarily. Fall
        // through to the retry loop so the next iteration picks up the token.
        // On non-Capacitor runtimes there is no injection race — exit to the
        // pairing gate immediately as before.
        if (!isCapacitorNative()) {
          deps.setAuthRequired(true);
          deps.setPairingEnabled(latestAuth.pairingEnabled);
          deps.setPairingExpiresAt(latestAuth.expiresAt);
          deps.setFirstRunLoading(false);
          dispatch({ type: "BACKEND_AUTH_REQUIRED" });
          return;
        }
      }
      if (
        (ae?.status === 401 || ae?.status === 429) &&
        client.hasToken() &&
        latestAuth.authenticated
      ) {
        // Bearer-only token (paired but no password session). /api/auth/status
        // returned authenticated:true but a downstream endpoint
        // (firstRun-status, etc.) still 401s, or the server's auth rate
        // limiter starts returning 429 ("Too many authentication attempts")
        // because every poll re-checks bearer-vs-session. /api/auth/me responds
        // with reason="remote_auth_required" in this state. Don't loop forever
        // — advance to ready so the top-level auth gate can render LoginView
        // with an actionable "Sign in" / "Remote access blocked" prompt.
        deps.setAuthRequired(false);
        deps.setFirstRunComplete(true);
        deps.setFirstRunLoading(false);
        dispatch({ type: "BACKEND_REACHED", firstRunComplete: true });
        return;
      }
      if (
        ae?.status === 401 &&
        client.hasToken() &&
        latestAuth.required &&
        latestAuth.authenticated === false
      ) {
        // Stale bearer: token is in storage and we've already seen
        // /api/auth/status report `required:true, authenticated:false`.
        // Server is definitively rejecting this session — retrying every
        // 250-1000ms for 15s won't change that, it just dead-ends on
        // BACKEND_TIMEOUT with the last 401 detail. Route straight to the
        // pairing/login gate so the user can re-pair or sign in.
        deps.setAuthRequired(true);
        deps.setPairingEnabled(latestAuth.pairingEnabled);
        deps.setPairingExpiresAt(latestAuth.expiresAt);
        deps.setFirstRunLoading(false);
        dispatch({ type: "BACKEND_AUTH_REQUIRED" });
        return;
      }
      if (ae?.status === 401 && client.hasToken()) {
        // 401-with-token but auth/status hasn't confirmed authenticated:true
        // OR authenticated:false yet — port race / pre-bearer endpoint
        // window before the first auth/status poll completes. Fall through
        // to retry.
      }
      if (ae?.status === 404) {
        deps.setStartupError(describeBackendFailure(err, false));
        deps.setFirstRunLoading(false);
        dispatch({ type: "BACKEND_NOT_FOUND" });
        return;
      }
      if (
        !fellBackToLocal &&
        shouldFallBackToLocalOrigin({ error: err, ...recoveryEnv() })
      ) {
        recoverToLocalOrigin("saved server unreachable");
        continue;
      }
      lastErr = err;
      attempts++;
      const delay = Math.min(250 * 2 ** Math.min(attempts, 2), 1000);
      await new Promise<void>((r) => {
        tidRef.current = setTimeout(r, delay);
      });
    }
  }
}
