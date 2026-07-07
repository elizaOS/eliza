/**
 * startup-phase-poll.ts
 *
 * Side-effect logic for the "polling-backend" startup phase.
 * Polls the backend until it responds, then dispatches BACKEND_REACHED
 * or an appropriate error/auth event.
 */

import { logger } from "@elizaos/logger";
import { getStylePresets } from "@elizaos/shared";
import type { FirstRunOptions } from "../api";
import { client } from "../api";
import {
  getAndroidLocalAgentBootStateForUrl,
  requestAndroidLocalAgentStartForUrl,
} from "../api/android-native-agent-transport";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities";
import {
  getCloudAuthToken,
  isDirectCloudSharedAgentBase,
} from "../api/client-cloud";
import {
  appendIosBootTrace,
  isIosInProcessLocalAgentBase,
  isIosNativeAgentBootInProgress,
  isTerminalIosNativeAgentBootErrorMessage,
} from "../api/ios-local-agent-transport";
import { getBackendStartupTimeoutMs } from "../bridge";
import { resumePendingCloudHandoff } from "../cloud/handoff/resume-pending-handoff";
import {
  ANDROID_LOCAL_AGENT_SERVER_ID,
  isMobileLocalAgentIpcBase,
  MOBILE_LOCAL_AGENT_IPC_BASE,
  MOBILE_LOCAL_AGENT_LABEL,
  MOBILE_LOCAL_AGENT_SERVER_ID,
  persistMobileRuntimeMode,
  readPersistedMobileRuntimeMode,
} from "../first-run/mobile-runtime-mode";
import { readMobileRuntimeBuildTruth } from "../first-run/reconcile-mobile-runtime-mode";
import type { FirstRunRuntimeTarget } from "../first-run/runtime-target";
import type { UiLanguage } from "../i18n";
import { isAndroid, isIOS } from "../platform";
import {
  dedicatedCloudAgentIdFromBase,
  isDedicatedCloudAgentBase,
  isElizaCloudControlPlaneAgentlessBase,
} from "../utils/cloud-agent-base";
import {
  asApiLikeError,
  deriveFirstRunResumeFieldsFromConfig,
  formatStartupErrorDetail,
  type StartupErrorState,
} from "./internal";
import {
  clearPersistedActiveServer,
  savePersistedActiveServer,
} from "./persistence";
import type { PlatformPolicy, StartupEvent } from "./startup-coordinator";
import { buildStaticFirstRunOptions } from "./startup-first-run-options";
import type { RestoringSessionCtx } from "./startup-phase-restore";

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
 * Default Capacitor-native consecutive-failure budget: after this long without
 * a single successful backend probe, the poll surfaces the error phase with
 * the last failure instead of sitting on the "Booting up…" splash for the full
 * `backendTimeoutMs` (issue #11030). Native policies override it via
 * `PlatformPolicy.nativeConsecutiveFailureBudgetMs`.
 */
const NATIVE_CONSECUTIVE_FAILURE_BUDGET_MS = 90_000;

/**
 * Per-request cap for a single startup probe (issue #13737). Well under the
 * consecutive-failure budget so a hung request fails fast and the loop retries
 * many times inside the overall `backendTimeoutMs`, guaranteeing the first
 * probe after the on-device agent's IPC socket comes up connects promptly.
 * Generous enough for one slow request on a low-end device (a 4 GB Android
 * cold-boots the full agent in ~60s, but any *individual* request that is
 * going to succeed resolves in well under 12s).
 */
const PROBE_REQUEST_TIMEOUT_MS = 12_000;

/**
 * A startup probe outlived the whole remaining phase budget without settling
 * (issue #11030: the iOS transport awaited Capacitor's raw plugin proxy — a
 * thenable whose `then` never calls back — freezing the poll loop forever).
 * Raised by the poll's own deadline race so the ordinary timeout/error paths
 * still run when a transport hangs.
 */
class ApiHangTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiHangTimeoutError";
  }
}

/**
 * Terminal 503 body from the Eliza Cloud dedicated-agent proxy
 * (packages/cloud/api/src/dedicated-agent-proxy.ts) when the agent sandbox
 * status is `error`: "Agent is in an error state. Resolve the failure before
 * connecting." Unlike the `starting`/`resuming` 503s (which self-heal via the
 * proxy's auto-resume), this one never clears without user action in the
 * cloud console — polling it just dead-ends the phone on the timeout card.
 * This was the REAL on-device #11030-follow-up failure: a stale persisted
 * `cloud` runtime mode pinned every launch (icon tap, devicectl, XCUITest) to
 * a dead dedicated agent, 503ing /api/auth/status until the 90s budget fired.
 */
const DEDICATED_CLOUD_AGENT_ERROR_STATE_FRAGMENT = "Agent is in an error state";

/**
 * True when the failure is the dedicated-agent proxy's terminal
 * sandbox-error 503 for the currently pinned dedicated cloud agent base.
 */
export function isTerminalDedicatedCloudAgentErrorState(args: {
  status: number | undefined;
  message: string | null | undefined;
  clientBaseUrl: string;
}): boolean {
  return (
    args.status === 503 &&
    typeof args.message === "string" &&
    args.message.includes(DEDICATED_CLOUD_AGENT_ERROR_STATE_FRAGMENT) &&
    isDedicatedCloudAgentBase(args.clientBaseUrl)
  );
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

// Direct elizaCloud control-plane API base, used to verify an agent record when
// a per-agent base 404s. Mirrors DEFAULT_DIRECT_CLOUD_API_BASE_URL in
// api/client-cloud.ts and DIRECT_CLOUD_API_BASE in startup-phase-restore.ts.
const DIRECT_CLOUD_API_BASE = "https://api.elizacloud.ai";

/**
 * A DEDICATED cloud agent base just 404'd on the first-run shell endpoints.
 * That 404 is ambiguous: it is the normal "no first-run shell on a cloud agent"
 * signal, OR the agent was deleted / its container is unreachable. Disambiguate
 * by verifying the agent record against the control-plane with the cloud auth
 * token (mirrors startup-phase-restore's `backfillCloudApiBase` probe).
 *
 * Returns true only when we positively confirm the agent is GONE (the lookup
 * 404s or reports no agent). In that case the saved server is cleared and the
 * caller routes to first-run agent selection instead of dead-ending on
 * "Backend Unreachable". Returns false when the agent still exists (treat the
 * original 404 as "first-run complete", same as the shared adapter) OR when we
 * cannot verify (no token / lookup error other than absence) — never strand the
 * user on an unprovable assumption.
 */
async function dedicatedCloudAgentIsGone(base: string): Promise<boolean> {
  const agentId = dedicatedCloudAgentIdFromBase(base);
  if (!agentId) return false;
  if (!getCloudAuthToken(client)) return false;

  const priorBaseUrl = client.getBaseUrl();
  const priorToken = client.hasToken();
  // getCloudCompatAgent resolves the control-plane via the client base, so point
  // the client at the control-plane (the dedicated subdomain is not a direct
  // cloud base and would route the lookup to the dead agent itself).
  client.setBaseUrl(DIRECT_CLOUD_API_BASE);
  try {
    const res = await client.getCloudCompatAgent(agentId);
    // success:false => the control-plane has no such agent record (deleted). A
    // successful lookup always carries the agent id, so success alone proves it
    // still exists.
    return !res.success;
  } catch (err) {
    // A 404 is the positive "agent is gone" signal. Any other failure
    // (network blip, 5xx) is inconclusive — do not strand the user.
    return asApiLikeError(err)?.status === 404;
  } finally {
    client.setBaseUrl(priorBaseUrl || null);
    if (!priorToken) client.setToken(null);
  }
}

export interface PollingBackendDeps {
  setStartupError: (v: StartupErrorState | null) => void;
  setAuthRequired: (v: boolean) => void;
  setFirstRunComplete: (v: boolean) => void;
  setFirstRunLoading: (v: boolean) => void;
  setFirstRunOptions: (v: FirstRunOptions) => void;
  setFirstRunRuntimeTarget: (v: FirstRunRuntimeTarget) => void;
  setFirstRunProvider: (v: string) => void;
  setFirstRunRemoteConnected: (v: boolean) => void;
  setFirstRunRemoteApiBase: (v: string) => void;
  setFirstRunRemoteToken: (v: string) => void;
  setFirstRunCloudProvisionedContainer: (v: boolean) => void;
  setPairingEnabled: (v: boolean) => void;
  setPairingExpiresAt: (v: number | null) => void;
  firstRunCompletionCommittedRef: React.MutableRefObject<boolean>;
  uiLanguage: UiLanguage;
}

/** Apply resume fields derived from a partial config to the first-run state. */
function applyFirstRunResumeFields(
  rf: ReturnType<typeof deriveFirstRunResumeFieldsFromConfig>,
  deps: Pick<
    PollingBackendDeps,
    | "setFirstRunRuntimeTarget"
    | "setFirstRunProvider"
    | "setFirstRunRemoteConnected"
    | "setFirstRunRemoteApiBase"
    | "setFirstRunRemoteToken"
  >,
): void {
  deps.setFirstRunRuntimeTarget(rf.firstRunRuntimeTarget);
  deps.setFirstRunProvider(rf.firstRunProvider);
  deps.setFirstRunRemoteConnected(rf.firstRunRemoteConnected);
  deps.setFirstRunRemoteApiBase(rf.firstRunRemoteApiBase);
  deps.setFirstRunRemoteToken(rf.firstRunRemoteToken);
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
  // Capacitor-native bounded boot (issue #11030): timestamp of the FIRST
  // failure in the current unbroken failure streak. Reset to null by any
  // successful probe; when the streak outlives the native budget the poll
  // exits to the error phase with the last failure instead of spinning
  // silently until `deadline`.
  const nativeFailureBudgetMs =
    policy.nativeConsecutiveFailureBudgetMs ??
    NATIVE_CONSECUTIVE_FAILURE_BUDGET_MS;
  let nativeFailureStreakStartedAt: number | null = null;
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

  // One-shot recovery to the bundled ON-DEVICE agent (issue: iOS icon-tap
  // startup timeout). A stale persisted `cloud` runtime mode can pin a
  // local-capable native build to a dedicated cloud agent that is DEAD
  // (sandbox status `error`, deleted, or unreachable). The boot-time
  // reconciler keeps that persisted choice because a cloud session/record
  // exists — it cannot probe. This poll CAN: once the cloud base proves
  // terminally dead, flip the runtime mode to `local`, repoint at the
  // on-device agent, and keep polling. Never applied to `remote-mac` /
  // `tunnel-to-mobile` (user-configured external endpoints), and only on
  // builds that actually ship the on-device engine.
  let recoveredToOnDeviceAgent = false;
  const canRecoverToOnDeviceLocalAgent = (): boolean => {
    if (recoveredToOnDeviceAgent) return false;
    if (!isCapacitorNative()) return false;
    const persistedMode = readPersistedMobileRuntimeMode();
    if (persistedMode !== "cloud" && persistedMode !== "cloud-hybrid") {
      return false;
    }
    if (isMobileLocalAgentIpcBase(client.getBaseUrl())) return false;
    try {
      return readMobileRuntimeBuildTruth(isAndroid ? "android" : "ios")
        .hasLocalEngine;
    } catch {
      return false;
    }
  };
  const recoverToOnDeviceLocalAgent = (why: string) => {
    recoveredToOnDeviceAgent = true;
    logger.warn(
      { staleBase: client.getBaseUrl(), reason: why },
      "[startup-phase-poll] persisted cloud agent is dead; falling back to the on-device local agent",
    );
    appendIosBootTrace("recover-to-on-device-agent", {
      staleBase: client.getBaseUrl(),
      reason: why,
    });
    persistMobileRuntimeMode("local");
    savePersistedActiveServer({
      id: isAndroid
        ? ANDROID_LOCAL_AGENT_SERVER_ID
        : MOBILE_LOCAL_AGENT_SERVER_ID,
      kind: "remote",
      label: MOBILE_LOCAL_AGENT_LABEL,
      apiBase: MOBILE_LOCAL_AGENT_IPC_BASE,
    });
    client.setBaseUrl(MOBILE_LOCAL_AGENT_IPC_BASE);
    client.setToken(null);
    deadline = Date.now() + policy.backendTimeoutMs;
    attempts = 0;
    lastErr = null;
    nativeFailureStreakStartedAt = null;
  };

  // Terminal recovery for a deleted/unreachable DEDICATED cloud agent: clear the
  // dead saved server + per-agent base/token, then route to first-run agent
  // selection (the user is still signed into Eliza Cloud — the cloud auth token
  // lives in its own storage and is untouched) instead of dead-ending on
  // "Backend Unreachable".
  const recoverToAgentSelection = (why: string) => {
    logger.warn(
      { staleBase: client.getBaseUrl(), reason: why },
      "[startup-phase-poll] abandoning the saved cloud agent; routing to agent selection",
    );
    appendIosBootTrace("recover-to-agent-selection", {
      staleBase: client.getBaseUrl(),
      reason: why,
    });
    clearPersistedActiveServer();
    client.setBaseUrl(null);
    client.setToken(null);
    deps.setFirstRunComplete(false);
    deps.setFirstRunLoading(false);
    dispatch({ type: "BACKEND_REACHED", firstRunComplete: false });
  };

  const isSameOriginProxyBase = () => {
    const base = client.getBaseUrl().trim();
    if (!base) return true;
    if (typeof window === "undefined") return false;
    try {
      return new URL(base).origin === window.location.origin;
    } catch {
      return false;
    }
  };

  const isDevUiPort = () =>
    typeof window !== "undefined" && window.location.port === "2138";

  const routeToOfflineFirstRun = (why: string) => {
    logger.warn(
      { reason: why },
      "[startup-phase-poll] backend is unavailable; routing to first-run without server options",
    );
    clearPersistedActiveServer();
    client.setBaseUrl(null);
    client.setToken(null);
    deps.setFirstRunOptions(buildStaticFirstRunOptions(deps.uiLanguage));
    deps.setFirstRunComplete(false);
    deps.setFirstRunLoading(false);
    dispatch({ type: "BACKEND_UNAVAILABLE_FIRST_RUN" });
  };

  if (
    !cancelled.current &&
    effectRunRef.current === effectRunId &&
    isDevUiPort() &&
    isSameOriginProxyBase() &&
    !ctx?.persistedActiveServer &&
    !ctx?.hadPriorFirstRun
  ) {
    routeToOfflineFirstRun(
      "dev web shell has no saved backend target; skipping same-origin API proxy probe",
    );
    return;
  }

  // Boot-trace bookkeeping (no-ops off native iOS): entry marker, capped
  // per-failure entries, and a first-success marker, so an unattended device
  // launch records WHICH base the poll hit and HOW it failed.
  let tracedPollFailures = 0;
  let tracedFirstSuccess = false;
  // Local-agent start requests already fired this phase entry, keyed by base
  // so a mid-phase base change (recoverToOnDeviceLocalAgent) gets its own.
  const nativeStartRequestedBases = new Set<string>();
  appendIosBootTrace("polling-backend-start", {
    baseUrl: client.getBaseUrl(),
    backendTimeoutMs: policy.backendTimeoutMs,
    nativeFailureBudgetMs,
  });

  // Stall detector (issue #11030 root-cause instrumentation): a startup probe
  // that neither resolves nor rejects is invisible to every failure path —
  // the loop just stops, no poll-failure entries, no timeout card. Arm a
  // one-shot tracer on the first few probes so a hung await is recorded in
  // the boot trace instead of silently wedging the phase.
  let stallTracersArmed = 0;
  const traceIfStalled = <T>(
    promise: Promise<T>,
    label: string,
  ): Promise<T> => {
    if (stallTracersArmed >= 3) return promise;
    stallTracersArmed += 1;
    const armedAt = Date.now();
    const stallTid = setTimeout(() => {
      appendIosBootTrace("probe-stalled", {
        label,
        baseUrl: client.getBaseUrl(),
        stalledForMs: Date.now() - armedAt,
        agentBootInProgress: isIosNativeAgentBootInProgress(),
      });
    }, 20_000);
    return promise.finally(() => clearTimeout(stallTid));
  };

  /**
   * Bound every probe await by a SHORT per-request timeout so a hung request
   * fails fast and the loop retries, instead of one hang consuming the whole
   * phase budget (issue #13737).
   *
   * The on-device iOS/Android boot proved two failure modes a probe must
   * survive: (a) a request that can NEVER settle — Capacitor's raw plugin
   * proxy is a thenable whose `then` never calls back; and (b) on Android
   * local-agent IPC, a request issued while the agent is still booting BLOCKS
   * on the not-yet-listening abstract socket (it does not fail-fast with
   * connection-refused). Bounding each probe by the *entire remaining phase
   * budget* (the old behavior) meant a single blocked request wedged the loop
   * for the whole 180s and the phone sat on "Booting up…" — even though the
   * agent became ready partway through. Bounding by a short cap instead spends
   * the 180s budget on many fast retries, so the first probe AFTER the agent's
   * socket comes up connects within one cap window. Never longer than the
   * remaining deadline (so we don't overshoot the overall ceiling); the
   * rejection flows through the ordinary streak-budget / deadline paths.
   */
  const boundedProbe = <T>(promise: Promise<T>): Promise<T> => {
    const remainingMs = Math.max(0, deadline - Date.now());
    const capMs = Math.max(1, Math.min(PROBE_REQUEST_TIMEOUT_MS, remainingMs));
    return new Promise<T>((resolve, reject) => {
      const hangTid = setTimeout(() => {
        reject(
          new ApiHangTimeoutError(
            `Startup probe did not settle within ${Math.round(capMs / 1000)}s — the request transport is hung (see the on-device boot trace, stage "probe-stalled"); retrying`,
          ),
        );
      }, capMs);
      promise.then(
        (value) => {
          clearTimeout(hangTid);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(hangTid);
          reject(error);
        },
      );
    });
  };

  while (!cancelled.current && effectRunRef.current === effectRunId) {
    if (Date.now() >= deadline) {
      appendIosBootTrace("backend-deadline-exceeded", {
        baseUrl: client.getBaseUrl(),
        detail: formatStartupErrorDetail(lastErr) ?? null,
      });
      deps.setStartupError(describeBackendFailure(lastErr, true));
      deps.setFirstRunLoading(false);
      dispatch({ type: "BACKEND_TIMEOUT" });
      return;
    }
    // The poll cannot wake the agent it is waiting for — an Android local-IPC
    // probe just blocks while nobody serves the socket — and on a fresh
    // install nobody else asks: the native auto-start gate was evaluated
    // before the renderer pre-seeded the local target, and onboarding (the
    // only other Agent.start() caller) is skipped on the pre-seeded path
    // (#15189). Request the start explicitly, once per polled base, so the
    // fresh boot, the Retry button, and a mid-phase recoverToOnDeviceLocalAgent
    // all revive the agent instead of timing out against a service that was
    // never started. Non-local bases no-op inside the helper.
    const polledBase = client.getBaseUrl();
    if (polledBase && !nativeStartRequestedBases.has(polledBase)) {
      nativeStartRequestedBases.add(polledBase);
      void requestAndroidLocalAgentStartForUrl(polledBase).then((requested) => {
        if (requested) {
          logger.info(
            "[startup-phase-poll] requested native local-agent start for the polled base",
          );
          appendIosBootTrace("native-agent-start-requested", {
            baseUrl: polledBase,
          });
        }
      });
    }
    try {
      const auth = await traceIfStalled(
        boundedProbe(client.getAuthStatus()),
        "auth-status",
      );
      latestAuth = auth;
      if (!tracedFirstSuccess) {
        tracedFirstSuccess = true;
        appendIosBootTrace("auth-status-ok", {
          baseUrl: client.getBaseUrl(),
          authRequired: auth.required,
        });
      }
      // A successful probe breaks the native consecutive-failure streak — the
      // transport works; any remaining slowness is the agent booting, which
      // the overall `deadline` already budgets for.
      nativeFailureStreakStartedAt = null;
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
      if (
        !supportsFullAppShellRoutes(client.getBaseUrl()) &&
        (deps.firstRunCompletionCommittedRef.current ||
          ctx?.shouldPreserveCompletedFirstRun === true)
      ) {
        deps.setFirstRunCloudProvisionedContainer(false);
        deps.setFirstRunComplete(true);
        deps.setFirstRunLoading(false);
        dispatch({ type: "BACKEND_REACHED", firstRunComplete: true });
        return;
      }
      const firstRunStatusRes = await traceIfStalled(
        boundedProbe(client.getFirstRunStatus()),
        "first-run-status",
      );
      const { complete, cloudProvisioned } = firstRunStatusRes;
      if (cancelled.current) return;
      deps.setFirstRunCloudProvisionedContainer(Boolean(cloudProvisioned));
      let sessionComplete =
        complete || deps.firstRunCompletionCommittedRef.current;

      // Preserve backend-complete installs even when this browser has no prior
      // local state (for example headless/VPS setups or a fresh visit to a
      // cloud-provisioned container). Only clear the optimistic completion
      // flag when the backend itself still reports firstRun as not complete.
      if (
        sessionComplete &&
        !complete &&
        !ctx?.persistedActiveServer &&
        !ctx?.hadPriorFirstRun
      ) {
        sessionComplete = false;
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
              boundedProbe(client.getFirstRunOptions()),
              // error-policy:J4 config only pre-fills resume fields; the
              // required options fetch fails loudly via the loop's deadline
              boundedProbe(client.getConfig()).catch(() => null),
            ]);
            // The effect may have been torn down (unmount / re-run) while the
            // fetch was in flight — bail before mutating state or dispatching,
            // matching the guards after the auth/first-run awaits above.
            if (cancelled.current) return;
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
            applyFirstRunResumeFields(rf, deps);
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
              if (isDirectCloudSharedAgentBase(client.getBaseUrl())) {
                // Shared-runtime cloud bridge: no /api/first-run* shell
                // endpoints exist (we provisioned it, so first-run IS done).
                // Treat the 404 as complete and go to chat — the bridge serves
                // /api/conversations via the REST chat adapter. A reload may
                // have interrupted the shared→dedicated migration — resume it.
                resumePendingCloudHandoff();
                deps.setFirstRunComplete(true);
                deps.setFirstRunLoading(false);
                dispatch({ type: "BACKEND_REACHED", firstRunComplete: true });
                return;
              }
              if (isElizaCloudControlPlaneAgentlessBase(client.getBaseUrl())) {
                // Signed into Eliza Cloud but no agent selected yet (base is the
                // control-plane / agents-collection URL with no /<agentId>).
                // Route to first-run agent selection, not "Backend Unreachable".
                deps.setFirstRunLoading(false);
                dispatch({ type: "BACKEND_REACHED", firstRunComplete: false });
                return;
              }
              if (isDedicatedCloudAgentBase(client.getBaseUrl())) {
                // A dedicated cloud agent (<id>.elizacloud.ai) 404s on the
                // first-run shell like the shared adapter — but it can also have
                // been DELETED or be unreachable. Verify the record against the
                // control-plane: if it is gone, clear the dead saved server and
                // route to agent selection instead of "Backend Unreachable"; if
                // it still exists, treat the 404 as first-run-complete.
                if (await dedicatedCloudAgentIsGone(client.getBaseUrl())) {
                  recoverToAgentSelection(
                    "saved dedicated cloud agent is deleted / unreachable",
                  );
                  return;
                }
                deps.setFirstRunComplete(true);
                deps.setFirstRunLoading(false);
                dispatch({ type: "BACKEND_REACHED", firstRunComplete: true });
                return;
              }
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
      tracedPollFailures += 1;
      if (tracedPollFailures <= 5 || tracedPollFailures % 10 === 0) {
        const failureMessage =
          ae?.message ?? (err instanceof Error ? err.message : String(err));
        appendIosBootTrace("poll-failure", {
          n: tracedPollFailures,
          baseUrl: client.getBaseUrl(),
          status: ae?.status ?? null,
          path: ae?.path ?? null,
          message: failureMessage.slice(0, 300),
          agentBootInProgress: isIosNativeAgentBootInProgress(),
        });
      }
      // Terminal native transport / agent-config failure (issue #11030): the
      // iOS local-agent IPC policy gate, a missing full-Bun engine, or the
      // native Agent plugin's missing-endpoint error. These depend only on
      // build config + the persisted runtime mode, neither of which changes
      // while this loop runs — retrying yields the identical rejection until
      // the deadline, which is the infinite "Booting up…" splash. Surface the
      // REAL message in the error phase (with Retry) immediately instead.
      const terminalMessage =
        ae?.message ?? (err instanceof Error ? err.message : String(err));
      if (
        isCapacitorNative() &&
        isTerminalIosNativeAgentBootErrorMessage(terminalMessage)
      ) {
        logger.warn(
          { message: terminalMessage, path: ae?.path },
          "[startup-phase-poll] terminal native agent/transport error during backend poll; surfacing the startup error",
        );
        appendIosBootTrace("agent-error-terminal", {
          baseUrl: client.getBaseUrl(),
          message: terminalMessage.slice(0, 300),
          path: ae?.path ?? null,
        });
        deps.setStartupError({
          reason: "agent-error",
          phase: "starting-backend",
          message: terminalMessage,
          detail: formatStartupErrorDetail(err),
        });
        deps.setFirstRunLoading(false);
        dispatch({ type: "AGENT_ERROR", message: terminalMessage });
        return;
      }
      // The dedicated-agent proxy's TERMINAL sandbox-error 503 ("Agent is in
      // an error state. Resolve the failure before connecting."). Retrying
      // never clears it — the sandbox needs user action in the cloud console.
      // On a local-capable native build with a stale persisted cloud mode,
      // recover to the bundled on-device agent; otherwise clear the dead
      // saved server and route to agent selection (mirrors the
      // dedicatedCloudAgentIsGone handling) instead of burning the whole
      // failure budget into the timeout card.
      if (
        isTerminalDedicatedCloudAgentErrorState({
          status: ae?.status,
          message: terminalMessage,
          clientBaseUrl: client.getBaseUrl(),
        })
      ) {
        if (canRecoverToOnDeviceLocalAgent()) {
          recoverToOnDeviceLocalAgent(
            "saved dedicated cloud agent is in a terminal error state",
          );
          continue;
        }
        recoverToAgentSelection(
          "saved dedicated cloud agent is in a terminal error state",
        );
        return;
      }
      if (ae?.status === 401 && !client.hasToken()) {
        // On Capacitor native the bearer token is injected asynchronously by
        // the native Agent plugin after the WebView boots. The first poll can
        // fire before that injection completes, producing a spurious 401 even
        // though the agent is up and will accept the token momentarily. Fall
        // through to the retry loop so the next iteration picks up the token.
        // On non-Capacitor runtimes there is no injection race — exit to the
        // pairing gate immediately as before.
        //
        // The async-injection race only exists for the on-device LOCAL agent
        // (the native Agent plugin injects its token). For a REMOTE target
        // (remote-connect onboarding to e.g. http://192.168.0.137:31337) a 401
        // is terminal pairing-required, never a transient race — so on native
        // we must still exit to the pairing gate when the base is not the local
        // agent, otherwise iOS polls the 401 forever and never reaches pairing.
        if (
          !isCapacitorNative() ||
          !isIosInProcessLocalAgentBase(client.getBaseUrl())
        ) {
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
        if (isDirectCloudSharedAgentBase(client.getBaseUrl())) {
          // Shared-runtime cloud bridge: no /api/first-run* shell endpoints
          // exist (we provisioned it, so first-run IS done). Treat the 404 as
          // complete and go to chat — the bridge serves /api/conversations via
          // the REST chat adapter — instead of wedging on BACKEND_NOT_FOUND.
          // A reload may have interrupted the shared→dedicated migration —
          // resume it.
          resumePendingCloudHandoff();
          deps.setFirstRunComplete(true);
          deps.setFirstRunLoading(false);
          dispatch({ type: "BACKEND_REACHED", firstRunComplete: true });
          return;
        }
        if (isElizaCloudControlPlaneAgentlessBase(client.getBaseUrl())) {
          // Signed into Eliza Cloud but no agent selected yet — route to
          // first-run agent selection instead of "Backend Unreachable".
          deps.setFirstRunLoading(false);
          dispatch({ type: "BACKEND_REACHED", firstRunComplete: false });
          return;
        }
        if (isDedicatedCloudAgentBase(client.getBaseUrl())) {
          // A dedicated cloud agent (<id>.elizacloud.ai) 404s on the first-run
          // shell — but it can also have been DELETED or be unreachable. Verify
          // the record against the control-plane: if it is gone, recover to the
          // bundled on-device agent (local-capable native build with a stale
          // persisted cloud mode) or clear the dead saved server and route to
          // agent selection instead of "Backend Unreachable"; if it still
          // exists, treat the 404 as first-run-complete.
          if (await dedicatedCloudAgentIsGone(client.getBaseUrl())) {
            if (canRecoverToOnDeviceLocalAgent()) {
              recoverToOnDeviceLocalAgent(
                "saved dedicated cloud agent is deleted / unreachable",
              );
              continue;
            }
            recoverToAgentSelection(
              "saved dedicated cloud agent is deleted / unreachable",
            );
            return;
          }
          deps.setFirstRunComplete(true);
          deps.setFirstRunLoading(false);
          dispatch({ type: "BACKEND_REACHED", firstRunComplete: true });
          return;
        }
        deps.setStartupError(describeBackendFailure(err, false));
        deps.setFirstRunLoading(false);
        dispatch({ type: "BACKEND_NOT_FOUND" });
        return;
      }
      if (
        isDevUiPort() &&
        !policy.supportsLocalRuntime &&
        isSameOriginProxyBase() &&
        (ae?.status === undefined ||
          ae.status === 502 ||
          ae.status === 503 ||
          ae.status === 504)
      ) {
        // Scope this destructive reset to the dev UI shell (port 2138) only.
        // On hosted web (app.elizacloud.ai) a transient gateway 5xx must NOT
        // eject an established user to onboarding — it falls through to the
        // normal retry/backoff loop below instead.
        routeToOfflineFirstRun(
          ae?.status === undefined
            ? "same-origin API proxy failed without an HTTP response"
            : `same-origin API proxy returned HTTP ${ae.status}`,
        );
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
      if (isCapacitorNative()) {
        // Android detached local agent now exposes the service-owned boot
        // state over the Capacitor plugin. That distinguishes a cold boot
        // from a launcher or child process death before the renderer's HTTP
        // probe can connect. Older plugins lack that method, so keep the
        // legacy hang/connect-failure heuristic only when the native state is
        // unknown. The overall `deadline` still bounds the whole phase.
        const androidLocalAgentIpc =
          isMobileLocalAgentIpcBase(client.getBaseUrl()) &&
          (isAndroid || isCapacitorNative());
        const androidBootState = androidLocalAgentIpc
          ? await getAndroidLocalAgentBootStateForUrl(client.getBaseUrl())
          : { state: "unknown" as const };
        const androidNativeBootProgress =
          androidBootState.state === "booting" ||
          androidBootState.state === "restarting" ||
          androidBootState.state === "listening";
        const legacyAndroidLocalAgentBooting =
          androidBootState.state === "unknown" &&
          androidLocalAgentIpc &&
          (err instanceof ApiHangTimeoutError ||
            (err as { status?: number } | undefined)?.status === undefined);
        if (
          isIosNativeAgentBootInProgress() ||
          androidNativeBootProgress ||
          legacyAndroidLocalAgentBooting
        ) {
          // PROGRESS-AWARE budget: native evidence says the local agent is
          // booting, restarting, or accepting connections. Older Android
          // plugins that lack the boot-state method keep the legacy HTTP
          // heuristic so existing builds remain bounded by the overall
          // deadline. A native `dead` state falls through and burns the
          // consecutive-failure budget.
          nativeFailureStreakStartedAt = null;
        } else {
          nativeFailureStreakStartedAt ??= Date.now();
          const failingForMs = Date.now() - nativeFailureStreakStartedAt;
          if (failingForMs >= nativeFailureBudgetMs) {
            const detail = formatStartupErrorDetail(err) ?? String(err);
            if (canRecoverToOnDeviceLocalAgent()) {
              // The persisted cloud base dead-ended for the whole budget on a
              // build that ships the on-device agent — recover to it instead
              // of stranding the user on the timeout card.
              recoverToOnDeviceLocalAgent(
                `native poll dead-ended after ${Math.round(failingForMs / 1000)}s: ${detail}`,
              );
              continue;
            }
            logger.warn(
              { failingForMs, detail },
              "[startup-phase-poll] native backend poll exceeded the consecutive-failure budget; surfacing the startup error",
            );
            appendIosBootTrace("native-failure-budget-exceeded", {
              failingForMs,
              detail,
              status: ae?.status ?? null,
              path: ae?.path ?? null,
            });
            deps.setStartupError({
              reason: "backend-timeout",
              phase: "starting-backend",
              message: `Startup could not reach the agent after ${Math.round(failingForMs / 1000)}s of consecutive failures. Last failure: ${detail}`,
              detail,
              status: ae?.status,
              path: ae?.path,
            });
            deps.setFirstRunLoading(false);
            dispatch({ type: "BACKEND_TIMEOUT" });
            return;
          }
        }
      }
      attempts++;
      const delay = Math.min(250 * 2 ** Math.min(attempts, 2), 1000);
      await new Promise<void>((r) => {
        tidRef.current = setTimeout(r, delay);
      });
    }
  }
}
