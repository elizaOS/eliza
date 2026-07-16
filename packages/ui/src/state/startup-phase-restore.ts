/**
 * startup-phase-restore.ts
 *
 * Side-effect logic for the "restoring-session" startup phase.
 * Probes for an existing install/connection and dispatches the result.
 */

import { logger } from "@elizaos/logger";
import {
  clearStoredStewardToken,
  hasStewardAuthedCookie,
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { client, type FirstRunOptions } from "../api";
import {
  cloudTokenSecsRemaining,
  isDirectCloudSharedAgentBase,
  refreshCloudStewardSession,
  resolveDirectCloudAuthApiBase,
} from "../api/client-cloud";
import {
  getBackendStartupTimeoutMs,
  invokeDesktopBridgeRequestWithTimeout,
  isElectrobunRuntime,
} from "../bridge";
import { getBootConfig } from "../config/boot-config";
import {
  ANDROID_LOCAL_AGENT_IPC_BASE,
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  IOS_LOCAL_AGENT_IPC_BASE,
  isCommittedOnDeviceMobileRuntimeMode,
  isMobileLocalAgentUrl,
  MOBILE_LOCAL_AGENT_LABEL,
  MOBILE_LOCAL_AGENT_SERVER_ID,
  readPersistedMobileRuntimeMode,
} from "../first-run/mobile-runtime-mode";
import { primeAuthStatusProbe } from "../hooks/useAuthStatus";
import type { UiLanguage } from "../i18n";
import {
  clearForceFreshFirstRun,
  isAndroid,
  isForceFreshFirstRunEnabled,
  isIOS,
  isNative,
  isOnboardingReplayRequested,
} from "../platform";
import {
  buildCloudSharedAgentApiBase,
  buildDedicatedCloudAgentApiBase,
  dedicatedCloudAgentIdFromBase,
  isDedicatedCloudAgentBase,
  isElizaCloudControlPlaneAgentlessBase,
} from "../utils/cloud-agent-base";
import { getElizaApiBase } from "../utils/eliza-globals";
import {
  detectExistingFirstRunConnection,
  type ExistingFirstRunProbeResult,
} from "./first-run-bootstrap";
import {
  clearPersistedActiveServer,
  hydratePersistedFirstRunCompleteFromNativeStore,
  loadPersistedActiveServer,
  loadPersistedFirstRunComplete,
  type PersistedActiveServer,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "./persistence";
import { isTrustedRestoreApiBaseUrl } from "./runtime-url-trust";
import type { StartupEvent } from "./startup-coordinator";
import { buildStaticFirstRunOptions } from "./startup-first-run-options";

const DESKTOP_RESTORE_RPC_TIMEOUT_MS = 5_000;

/**
 * A stored Steward JWT with at least this many seconds of life left restores
 * as-is (no refresh). Below it — or already expired — the restore boundary
 * refreshes first so we never hand the client a dead token. Mirrors
 * `STEWARD_REFRESH_AHEAD_SECS` in `state/useCloudState.ts` and
 * `PRE_RENDER_REFRESH_AHEAD_SECS` in the native apps studio.
 */
const STEWARD_RESTORE_REFRESH_AHEAD_SECS = 120;
/**
 * Hard cap on how long the restore-boundary Steward refresh may block startup.
 * The refresh is a network POST that can hang; if it doesn't settle in time we
 * fall back to the stored/provision token (the useCloudState lifecycle refresh
 * and the api-client 401 self-heal remain the backstops).
 */
const STEWARD_RESTORE_REFRESH_TIMEOUT_MS = 4_000;
/** Bound the non-blocking legacy runtime-tier repair lookup. */
const CLOUD_AGENT_TIER_PROBE_TIMEOUT_MS = 12_000;
/** Steward refresh endpoint path (same-origin on web; `api.` host on native). */
const STEWARD_REFRESH_PATH = "/api/auth/steward-refresh";
/** Default direct Cloud site base used to derive the native refresh endpoint. */
const RESTORE_DEFAULT_DIRECT_CLOUD_BASE_URL = "https://elizacloud.ai";

function recoverCloudAgentId(active: PersistedActiveServer): string | null {
  const rawId = active.id?.startsWith("cloud:")
    ? active.id.slice("cloud:".length).trim()
    : "";
  if (rawId && !rawId.includes("/")) return rawId;
  return dedicatedCloudAgentIdFromBase(active.apiBase);
}

function isDevUiPort(): boolean {
  return typeof window !== "undefined" && window.location.port === "2138";
}

/**
 * Repair an older persisted dedicated-looking base when the owner record says
 * it is actually a temporary shared bridge. This runs off the startup critical
 * path: an inconclusive lookup leaves the already-bound target untouched.
 */
async function reconcileLegacyDedicatedCloudApiBase(
  active: PersistedActiveServer,
  stewardToken: string | null,
): Promise<PersistedActiveServer | null> {
  if (!stewardToken || !isDedicatedCloudAgentBase(active.apiBase)) return null;
  const agentId = recoverCloudAgentId(active);
  if (!agentId) return null;
  const cloudApiBase = resolveDirectCloudAuthApiBase(
    getBootConfig().cloudApiBase || RESTORE_DEFAULT_DIRECT_CLOUD_BASE_URL,
  );
  try {
    const response = await fetch(
      `${cloudApiBase}/api/v1/eliza/agents/${encodeURIComponent(agentId)}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${stewardToken}`,
        },
        signal: AbortSignal.timeout(CLOUD_AGENT_TIER_PROBE_TIMEOUT_MS),
      },
    );
    if (!response.ok) return null;
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null) return null;
    const data = (payload as Record<string, unknown>).data;
    if (typeof data !== "object" || data === null) return null;
    const tier = (data as Record<string, unknown>).executionTier;
    if (tier !== "shared") return null;
    return {
      ...active,
      apiBase: buildCloudSharedAgentApiBase(cloudApiBase, agentId),
    };
  } catch {
    // error-policy:J4 this is a compatibility repair probe; the normal startup
    // poll remains authoritative when the control plane is temporarily down.
    return null;
  }
}

/**
 * Repair a restored managed-cloud target using the current environment and,
 * for legacy dedicated-looking records, the server-authoritative runtime tier.
 */
function backfillCloudApiBase(
  active: PersistedActiveServer,
): PersistedActiveServer {
  if (active.kind !== "cloud") return active;
  const agentId = recoverCloudAgentId(active);
  if (!agentId) return active;
  const cloudApiBase =
    getBootConfig().cloudApiBase ||
    active.apiBase ||
    RESTORE_DEFAULT_DIRECT_CLOUD_BASE_URL;
  const dedicatedApiBase = buildDedicatedCloudAgentApiBase(
    agentId,
    cloudApiBase,
  );
  if (!dedicatedApiBase) return active;
  const sharedApiBase = buildCloudSharedAgentApiBase(
    resolveDirectCloudAuthApiBase(cloudApiBase),
    agentId,
  );
  const managedBase =
    !active.apiBase ||
    isElizaCloudControlPlaneAgentlessBase(active.apiBase) ||
    isDirectCloudSharedAgentBase(active.apiBase) ||
    isDedicatedCloudAgentBase(active.apiBase);
  // Custom per-agent hosts are server-owned and must remain untouched.
  if (!managedBase) return active;

  const repairedApiBase = isDirectCloudSharedAgentBase(active.apiBase)
    ? sharedApiBase
    : dedicatedApiBase;
  if (active.apiBase === repairedApiBase) return active;

  const updated: PersistedActiveServer = {
    ...active,
    apiBase: repairedApiBase,
  };
  savePersistedActiveServer(updated);
  return updated;
}

export interface RestoringSessionDeps {
  setStartupError: (v: null) => void;
  setAuthRequired: (v: boolean) => void;
  setConnected: (v: boolean) => void;
  setFirstRunOptions: (v: FirstRunOptions) => void;
  setFirstRunComplete: (v: boolean) => void;
  setFirstRunLoading: (v: boolean) => void;
  firstRunCompletionCommittedRef: React.MutableRefObject<boolean>;
  uiLanguage: UiLanguage;
}

export interface RestoringSessionCtx {
  persistedActiveServer: ReturnType<typeof loadPersistedActiveServer>;
  restoredActiveServer: PersistedActiveServer;
  shouldPreserveCompletedFirstRun: boolean;
  hadPriorFirstRun: boolean;
}

function isMobileLocalAgentApiBase(value: string | undefined): boolean {
  return isMobileLocalAgentUrl(value);
}

function isMobileLocalActiveServer(server: PersistedActiveServer): boolean {
  return server.kind === "local" || isMobileLocalAgentApiBase(server.apiBase);
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

// Re-resolve a persisted loopback apiBase against whatever port the
// dev orchestrator / Electrobun bridge actually bound this run. A
// previous session may have captured a stale port (e.g. 31337) when
// the live API has moved (e.g. 31338). Without this, every restore
// re-applies the dead URL and the renderer 404s on every fetch.
function reconcilePersistedApiBaseWithLive(
  apiBase: string | undefined,
): string | undefined {
  if (!apiBase) return apiBase;
  const live = getElizaApiBase();
  if (!live || live === apiBase) return apiBase;
  try {
    const persisted = new URL(apiBase);
    if (!isLoopbackHostname(persisted.hostname)) return apiBase;
    const liveUrl = new URL(live);
    if (!isLoopbackHostname(liveUrl.hostname)) return apiBase;
    return live;
  } catch {
    return apiBase;
  }
}

type MobileNativePlatform = "android" | "ios";

function mobileLocalActiveServer(
  platform: MobileNativePlatform = isAndroid ? "android" : "ios",
): PersistedActiveServer {
  const android = platform === "android";
  return {
    id: android ? ANDROID_LOCAL_AGENT_SERVER_ID : MOBILE_LOCAL_AGENT_SERVER_ID,
    kind: "remote",
    label: android ? ANDROID_LOCAL_AGENT_LABEL : MOBILE_LOCAL_AGENT_LABEL,
    apiBase: android ? ANDROID_LOCAL_AGENT_IPC_BASE : IOS_LOCAL_AGENT_IPC_BASE,
  };
}

export function reconcileMobileRestoredActiveServer(args: {
  server: PersistedActiveServer;
  mobileRuntimeMode: ReturnType<typeof readPersistedMobileRuntimeMode>;
  platform: MobileNativePlatform;
}): PersistedActiveServer | null | undefined {
  const { server, mobileRuntimeMode, platform } = args;
  const mobileLocal = isMobileLocalActiveServer(server);
  // The on-device agent is the chat target for BOTH committed on-device modes
  // — `local` (on-device inference) and `cloud-hybrid` (cloud inference, but
  // the on-device agent still owns chat, plugins, the voice bridge, and device
  // control) — and first-run-finish persists the on-device active-server record
  // for either. Only reject the record when the persisted mode does NOT run a
  // bundled agent (`cloud`/`remote-mac`/`tunnel-to-mobile`): rejecting it for
  // `cloud-hybrid` cleared the record + reset first-run on every cold launch,
  // bouncing a returning hybrid user into onboarding while the ~30s-booting
  // agent was still unreachable.
  if (mobileLocal && !isCommittedOnDeviceMobileRuntimeMode(mobileRuntimeMode)) {
    return null;
  }

  const expectedMobileIpcBase =
    platform === "android"
      ? ANDROID_LOCAL_AGENT_IPC_BASE
      : IOS_LOCAL_AGENT_IPC_BASE;
  if (
    server.kind === "local" ||
    (mobileLocal && server.apiBase !== expectedMobileIpcBase)
  ) {
    return mobileLocalActiveServer(platform);
  }

  if (!server.apiBase) {
    return null;
  }

  return undefined;
}

function restoredLocalApiBase(): string | null {
  if (isAndroid || isIOS) {
    return null;
  }
  return getElizaApiBase() ?? null;
}

async function getDesktopRuntimeModeForStartup(): Promise<{
  mode?: string;
} | null> {
  const result = await invokeDesktopBridgeRequestWithTimeout<{ mode?: string }>(
    {
      rpcMethod: "desktopGetRuntimeMode",
      ipcChannel: "desktop:getRuntimeMode",
      timeoutMs: DESKTOP_RESTORE_RPC_TIMEOUT_MS,
    },
  );
  return result.status === "ok" ? result.value : null;
}

async function requestDesktopAgentStartForStartup(): Promise<void> {
  await invokeDesktopBridgeRequestWithTimeout({
    rpcMethod: "agentStart",
    ipcChannel: "agent:start",
    timeoutMs: DESKTOP_RESTORE_RPC_TIMEOUT_MS,
  });
}

/**
 * Resolve the Steward refresh endpoint for the current target. Hosted web uses
 * the same-origin cookie path (the HttpOnly `steward-refresh-token` cookie
 * travels automatically), so we return `undefined` to let
 * {@link refreshCloudStewardSession} fall back to its same-origin default.
 * Native/Electrobun has no same-origin cookie, so refresh against the configured
 * Cloud API base (Bearer-refresh). Mirrors
 * `resolveStewardRefreshEndpoint` in `state/useCloudState.ts`.
 */
function resolveRestoreStewardRefreshEndpoint(): string | undefined {
  if (!isNative && !isElectrobunRuntime()) return undefined;
  const cloudBase =
    getBootConfig().cloudApiBase?.trim() ||
    RESTORE_DEFAULT_DIRECT_CLOUD_BASE_URL;
  try {
    const url = new URL(cloudBase);
    const host = url.hostname.toLowerCase();
    const apiHost =
      host === "elizacloud.ai" ||
      host === "www.elizacloud.ai" ||
      host === "dev.elizacloud.ai"
        ? "api.elizacloud.ai"
        : host;
    return `${url.protocol}//${apiHost}${STEWARD_REFRESH_PATH}`;
  } catch {
    return undefined;
  }
}

/**
 * Pick the Steward token to hand the client when restoring a cloud session.
 *
 * A returning user's stored JWT can EXPIRE while the app is closed. Blindly
 * setting an expired token boots into a permanently-401ing session: the
 * proactive lifecycle refresh (useCloudState) is the only other refresh path,
 * and a stale token means the very first authed call 401s — so the connection
 * never establishes and the refresh that would have healed it is starved. To
 * break that deadlock at the restore boundary, before handing the token to the
 * client we:
 *   - use a comfortably-valid JWT as-is (instant restore, no needless refresh);
 *   - leave an opaque / device-code token (no decodable `exp`) untouched;
 *   - refresh an expired / near-expiry JWT (cookie path on web, Bearer on
 *     native), bounded by a timeout so a hung network can't stall startup;
 *   - on a failed refresh, drain a truly-expired token and return `null`
 *     (unauthenticated) rather than dial with a known-dead credential — a
 *     merely near-expiry-but-still-live token is kept so the useCloudState
 *     lifecycle refresh can retry ahead of the real `exp`.
 *
 * The refresh runs at most once per restore, so there is no refresh loop.
 */
async function resolveRestoredStewardToken(): Promise<string | null> {
  const stored = readStoredStewardToken()?.trim();
  if (!stored) {
    // No app-origin token, but the shared, HttpOnly .elizacloud.ai session
    // cookie is present — the user signed in on the console (or another
    // *.elizacloud.ai tab). Recover the access token from it (bounded, same as
    // the /login page) instead of forcing a redundant re-sign-in; on success
    // the top-level LoginView gate and the first-run conductor both skip.
    if (typeof window !== "undefined" && hasStewardAuthedCookie()) {
      let cookieTimeout: ReturnType<typeof setTimeout> | undefined;
      const recovered = await Promise.race([
        // error-policy:J4 a failed cookie refresh falls through to
        // unauthenticated restore (sign-in wall), never fabricates a session.
        refreshCloudStewardSession({
          endpoint: resolveRestoreStewardRefreshEndpoint(),
        }).catch(() => null),
        new Promise<null>((resolve) => {
          cookieTimeout = setTimeout(
            () => resolve(null),
            STEWARD_RESTORE_REFRESH_TIMEOUT_MS,
          );
        }),
      ]);
      if (cookieTimeout) clearTimeout(cookieTimeout);
      if (recovered?.token) {
        writeStoredStewardToken(recovered.token);
        try {
          window.dispatchEvent(new CustomEvent("steward-token-sync"));
        } catch {
          // error-policy:J6 best-effort nudge — listeners re-read next tick.
        }
        return recovered.token;
      }
    }
    return null;
  }
  const secs = cloudTokenSecsRemaining(stored);
  // Opaque/device-code token (no decodable `exp`) → nothing to refresh.
  if (secs === null) return stored;
  // Comfortably valid → restore instantly.
  if (secs >= STEWARD_RESTORE_REFRESH_AHEAD_SECS) return stored;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const refreshed = await Promise.race([
    // error-policy:J4 refresh failure is handled explicitly below: an expired
    // token is dropped (restore unauthenticated), a still-valid one is kept
    refreshCloudStewardSession({
      endpoint: resolveRestoreStewardRefreshEndpoint(),
    }).catch(() => null),
    new Promise<null>((resolve) => {
      timeout = setTimeout(
        () => resolve(null),
        STEWARD_RESTORE_REFRESH_TIMEOUT_MS,
      );
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  if (refreshed?.token) {
    writeStoredStewardToken(refreshed.token);
    // Let the native Steward auth context + any storage listeners pick up the
    // fresh JWT without waiting for the next read.
    try {
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("steward-token-sync"));
      }
    } catch {
      // error-policy:J6 best-effort nudge — listeners re-read on their next
      // tick regardless
    }
    return refreshed.token;
  }

  // Refresh failed / timed out. A truly-expired token is a dead credential —
  // drop it so we restore unauthenticated instead of a guaranteed-401 dial.
  if (secs <= 0) {
    clearStoredStewardToken();
    return null;
  }
  return stored;
}

export async function applyRestoredConnection(args: {
  restoredActiveServer: PersistedActiveServer;
  clientRef: Pick<typeof client, "setBaseUrl" | "setToken">;
  startLocalRuntime?: () => Promise<void>;
}) {
  const { restoredActiveServer, clientRef, startLocalRuntime } = args;

  if (restoredActiveServer.kind === "local") {
    // Don't clear an already-set token: "local" means the agent runs
    // on this machine, not that the dashboard is unauthenticated.
    clientRef.setBaseUrl(restoredLocalApiBase());
    if (startLocalRuntime) {
      await startLocalRuntime();
    }
    return;
  }

  if (restoredActiveServer.kind === "cloud") {
    // Environment reconciliation is synchronous so the client is routed
    // immediately. The slower legacy tier check and Steward refresh then run
    // concurrently; neither blocks the initial base mutation.
    // Never send an agent-local paired token to the Cloud control plane. The
    // Steward session store is the only valid credential for this owner lookup.
    const restoreProbeToken = readStoredStewardToken()?.trim() || null;
    const resolved = backfillCloudApiBase(restoredActiveServer);
    clientRef.setBaseUrl(resolved.apiBase ?? null);
    const tierRepairPromise = isDedicatedCloudAgentBase(
      restoredActiveServer.apiBase,
    )
      ? reconcileLegacyDedicatedCloudApiBase(resolved, restoreProbeToken)
      : Promise.resolve(null);
    const stewardTokenPromise = resolveRestoredStewardToken();
    // Cloud = Steward everywhere (DECISIONS.md D3): prefer the live Steward
    // session token over the token captured at provision time (which may have
    // rotated since). If that stored JWT expired while the app was closed,
    // refresh it BEFORE handing it to the client so a returning user never
    // boots into a permanently-401ing session (see resolveRestoredStewardToken).
    const stewardToken = await stewardTokenPromise;
    // Dedicated agent subdomains use an agent-local paired token for `/api/*`.
    // Prefer a persisted paired token there, but keep the Steward fallback so
    // older stale installs still reach the startup re-pair recovery path.
    clientRef.setToken(
      isDedicatedCloudAgentBase(resolved.apiBase)
        ? resolved.accessToken || stewardToken || null
        : stewardToken || resolved.accessToken || null,
    );
    void tierRepairPromise.then((repaired) => {
      if (!repaired || repaired.apiBase === resolved.apiBase) return;
      const current = loadPersistedActiveServer();
      // A user can switch agents while the compatibility probe is in flight.
      // Never overwrite a newer selection; null is allowed for direct unit
      // callers that did not seed persistence.
      if (
        current &&
        (current.id !== resolved.id || current.apiBase !== resolved.apiBase)
      ) {
        return;
      }
      savePersistedActiveServer(repaired);
      clientRef.setBaseUrl(repaired.apiBase ?? null);
      clientRef.setToken(stewardToken || repaired.accessToken || null);
    });
    return;
  }

  if (isMobileLocalActiveServer(restoredActiveServer)) {
    // Bundled mobile on-device agent (`eliza-local-agent://ipc`): a native
    // Capacitor IPC identity, not a network host — no socket dial, no bearer
    // token. Route the client at the IPC base; the full-Bun engine starts
    // lazily on the first /api request through the iOS/Android local-agent
    // transport. Without this branch the remote-host SECURITY backstop below
    // dropped the record on every cold launch (see canRestoreActiveServer).
    clientRef.setBaseUrl(restoredActiveServer.apiBase ?? null);
    return;
  }

  const reconciled = reconcilePersistedApiBaseWithLive(
    restoredActiveServer.apiBase,
  );
  // SECURITY backstop (the primary gate is canRestoreActiveServer): never dial
  // an untrusted persisted remote host or attach the bearer token to it — drop
  // the record and fall back to first-run instead.
  if (!isTrustedRestoreApiBaseUrl(reconciled)) {
    logger.warn(
      `[startup-phase-restore] dropping persisted remote active-server with untrusted apiBase host: ${reconciled ?? "(none)"}`,
    );
    clearPersistedActiveServer();
    return;
  }
  if (reconciled && reconciled !== restoredActiveServer.apiBase) {
    savePersistedActiveServer({
      ...restoredActiveServer,
      apiBase: reconciled,
    });
  }
  clientRef.setBaseUrl(reconciled ?? null);
  clientRef.setToken(restoredActiveServer.accessToken ?? null);
}

function activeServerToTarget(
  server: PersistedActiveServer,
): "embedded-local" | "cloud-managed" | "remote-backend" {
  if (isMobileLocalActiveServer(server)) return "embedded-local";

  switch (server.kind) {
    case "local":
      return "embedded-local";
    case "cloud":
      return "cloud-managed";
    case "remote":
      return "remote-backend";
  }
}

export function canRestoreActiveServer(args: {
  server: PersistedActiveServer;
  clientApiAvailable: boolean;
  isDesktop: boolean;
}): boolean {
  if (args.server.apiBase) {
    // The bundled mobile on-device agent (`eliza-local-agent://ipc`) is a
    // native Capacitor IPC identity, not a network host — restoring it never
    // dials a socket or attaches a bearer token to a remote, so the
    // http/https remote-host trust gate below must not drop it. Without this
    // branch every iOS/Android local-mode cold launch cleared the saved
    // server AND `eliza:first-run-complete`, bouncing the user back into
    // onboarding and never starting the on-device engine.
    // reconcileMobileRestoredActiveServer has already validated the persisted
    // runtime mode for this record before restore reaches this gate.
    if (isMobileLocalActiveServer(args.server)) {
      return true;
    }
    // A "remote" record with an untrusted apiBase host must not be restored —
    // restoring it would dial an attacker-chosen server with the persisted
    // bearer token. Untrusted → not restorable → the caller clears it and falls
    // back to first-run. local/cloud branches validate their own hosts.
    if (args.server.kind === "remote") {
      return isTrustedRestoreApiBaseUrl(args.server.apiBase);
    }
    return true;
  }

  if (args.server.kind === "local") {
    return args.isDesktop || args.clientApiAvailable;
  }

  if (args.server.kind === "cloud") {
    // A persisted cloud agent without a concrete apiBase is still restorable
    // when its id carries a real agent id: applyRestoredConnection →
    // backfillCloudApiBase recovers the base from `cloud:<agentId>` (or the
    // live Steward session). Only an id-less / URL-as-id session (which the
    // backfill cannot recover) falls through to agent selection. Keep this in
    // sync with backfillCloudApiBase's recoverability check.
    const rawId = args.server.id?.startsWith("cloud:")
      ? args.server.id.slice("cloud:".length).trim()
      : "";
    return Boolean(rawId && !rawId.includes("/"));
  }

  return false;
}

function preserveCloudAuthTokenForFirstRun(
  server: PersistedActiveServer,
): void {
  if (server.kind !== "cloud") return;
  // Cloud = Steward everywhere (DECISIONS.md D3): the Steward session token
  // persists in localStorage independently of the dropped active server, so
  // prefer it; fall back to the token captured on the persisted server.
  const token = readStoredStewardToken()?.trim() || server.accessToken?.trim();
  if (!token) return;
  client.setToken(token);
}

/**
 * Runs the restoring-session phase.
 * Probes the local Eliza install and/or API to detect an existing connection,
 * then dispatches SESSION_RESTORED or NO_SESSION.
 *
 * @param deps - Coordinator dependency bag
 * @param dispatch - startupReducer dispatch
 * @param ctxRef - Mutable ref shared with the polling-backend phase
 * @param cancelled - Ref-flag set true by the cleanup function
 */
export async function runRestoringSession(
  deps: RestoringSessionDeps,
  dispatch: (event: StartupEvent) => void,
  ctxRef: React.MutableRefObject<RestoringSessionCtx | null>,
  cancelled: { current: boolean },
): Promise<void> {
  deps.setStartupError(null);
  deps.setAuthRequired(false);
  deps.setConnected(false);

  // Restore the onboarding-complete flag from the durable native store when a
  // WebView-storage wipe dropped it from localStorage (issue #11506), BEFORE
  // reading `hadPrior` below — so an already set-up mobile install is not
  // re-onboarded on the boot after the wipe. No-op on web/desktop and whenever
  // localStorage still carries the flag.
  await hydratePersistedFirstRunCompleteFromNativeStore();
  if (cancelled.current) return;
  let persistedActiveServer = loadPersistedActiveServer();
  let hadPrior = loadPersistedFirstRunComplete();
  const forceFreshFirstRun = isForceFreshFirstRunEnabled();
  if (forceFreshFirstRun) {
    // force-fresh is a ONE-SHOT directive: it forces exactly one fresh
    // onboarding after an escape hatch (unreachable backend, pairing dead-end,
    // ?reset). Clear it the moment restore consumes it so the *next* launch is
    // back to normal server-authoritative behavior. Previously it was only
    // cleared by the submitFirstRun client patch, so any completion path that
    // doesn't POST first-run (cloud shared-agent's swallowed 404, pairing
    // early-return) left the flag set — re-onboarding the user on every launch.
    clearForceFreshFirstRun();
    clearPersistedActiveServer();
    savePersistedFirstRunComplete(false);
    persistedActiveServer = null;
    hadPrior = false;
    deps.firstRunCompletionCommittedRef.current = false;
    client.setBaseUrl(null);
    client.setToken(null);
  }
  if (cancelled.current) return;

  const isDesktop = isElectrobunRuntime();

  // One desktop runtime-mode RPC per restore run: both consumers (the local
  // agent autostart gate in startLocalRuntime and the embedded-local target
  // reclassification before dispatch) share this memo instead of dialing the
  // 5s-timeout bridge twice. Per-run — not module-scoped — because the shell's
  // mode can change between restore retries. The mode is shell config, stable
  // within a single startup, so sharing one result is safe.
  let desktopRuntimeModePromise: Promise<{ mode?: string } | null> | null =
    null;
  const desktopRuntimeMode = (): Promise<{ mode?: string } | null> => {
    desktopRuntimeModePromise ??= getDesktopRuntimeModeForStartup().catch(
      () => null,
    );
    return desktopRuntimeModePromise;
  };

  // Probe the API when there is evidence of a prior install, or when no
  // persisted server exists (covers headless/VPS setups where config was
  // set via files without going through UI firstRun).
  //
  // A committed mobile on-device runtime (`local`/`cloud-hybrid`) means the
  // native service is bringing the bundled agent up right now; its ~30s cold
  // boot on a low-power phone outlasts the 3.5s single-shot probe, so wait for
  // it (up to 45s) instead of dropping the returning user back into first-run
  // every cold launch. A fresh install (no committed mode) keeps the fast
  // single-shot.
  const committedMobileOnDeviceMode =
    (isAndroid || isIOS) &&
    isCommittedOnDeviceMobileRuntimeMode(readPersistedMobileRuntimeMode());
  const shouldProbeExistingInstall =
    !forceFreshFirstRun && !persistedActiveServer && !isDevUiPort();
  let probed: ExistingFirstRunProbeResult | null = null;
  if (shouldProbeExistingInstall) {
    try {
      probed = await detectExistingFirstRunConnection({
        client,
        timeoutMs: isDesktop
          ? Math.min(getBackendStartupTimeoutMs(), 30_000)
          : committedMobileOnDeviceMode
            ? Math.min(getBackendStartupTimeoutMs(), 45_000)
            : Math.min(getBackendStartupTimeoutMs(), 3_500),
        waitForBootingAgent: committedMobileOnDeviceMode,
      });
    } catch (err) {
      // error-policy:J1 existing-install probe boundary. The probe only throws
      // in wait-for-boot mode, and only for a GENUINE fault — the committed
      // on-device agent answered with auth/5xx/malformed, not a still-booting
      // heartbeat. The install exists, so re-onboarding would both lose the
      // user's setup and mask the fault: instead route to restore as a detected
      // install and let the polling-backend phase surface the real error
      // through its designed timeout/error states.
      logger.error(
        `[startup-phase-restore] existing-install probe failed for a committed on-device runtime: ${err instanceof Error ? err.message : String(err)}`,
      );
      probed = {
        activeServer: mobileLocalActiveServer(isAndroid ? "android" : "ios"),
        detectedExistingInstall: true,
      };
    }
  }
  if (cancelled.current) return;

  let restoredActiveServer =
    persistedActiveServer ?? (probed ? probed.activeServer : null);

  if ((isAndroid || isIOS) && restoredActiveServer) {
    const reconciledMobileServer = reconcileMobileRestoredActiveServer({
      server: restoredActiveServer,
      mobileRuntimeMode: readPersistedMobileRuntimeMode(),
      platform: isAndroid ? "android" : "ios",
    });
    if (reconciledMobileServer === null) {
      clearPersistedActiveServer();
      savePersistedFirstRunComplete(false);
      persistedActiveServer = null;
      restoredActiveServer = null;
      hadPrior = false;
      deps.firstRunCompletionCommittedRef.current = false;
    } else if (reconciledMobileServer) {
      restoredActiveServer = reconciledMobileServer;
      persistedActiveServer = restoredActiveServer;
      savePersistedActiveServer(restoredActiveServer);
    }
  }

  if (
    restoredActiveServer &&
    !canRestoreActiveServer({
      server: restoredActiveServer,
      clientApiAvailable: client.apiAvailable,
      isDesktop,
    })
  ) {
    preserveCloudAuthTokenForFirstRun(restoredActiveServer);
    clearPersistedActiveServer();
    savePersistedFirstRunComplete(false);
    persistedActiveServer = null;
    restoredActiveServer = null;
    hadPrior = false;
    deps.firstRunCompletionCommittedRef.current = false;
  }

  const preserveCompleted =
    hadPrior &&
    !deps.firstRunCompletionCommittedRef.current &&
    !isOnboardingReplayRequested();

  if (!restoredActiveServer) {
    // No saved backend found — let the user (re-)onboard.
    deps.setFirstRunOptions(buildStaticFirstRunOptions(deps.uiLanguage));
    deps.setFirstRunComplete(false);
    deps.setFirstRunLoading(false);
    dispatch({ type: "NO_SESSION", hadPriorFirstRun: hadPrior });
    return;
  }

  // Only a restored kind:"local" server ever consumes the runtime mode (both
  // call sites below), so kick the RPC off for exactly that case — it then
  // runs while the sync restore gates above settle instead of serializing
  // inside startLocalRuntime.
  if (isDesktop && restoredActiveServer.kind === "local") {
    void desktopRuntimeMode();
  }

  await applyRestoredConnection({
    restoredActiveServer,
    clientRef: client,
    startLocalRuntime: async () => {
      try {
        const runtimeMode = await desktopRuntimeMode();
        if (runtimeMode && runtimeMode.mode !== "local") {
          return;
        }
        await requestDesktopAgentStartForStartup();
      } catch (err) {
        logger.warn(
          `[startup-phase-restore] desktop agent bridge request failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  });

  // The connection is applied (base URL + token are what the post-paint auth
  // gate will use), so start the /api/auth/me probe now — it overlaps the
  // polling/hydration phases instead of serializing after first paint. See
  // primeAuthStatusProbe for why a mid-boot 503 outcome is discarded.
  primeAuthStatusProbe();

  ctxRef.current = {
    persistedActiveServer,
    restoredActiveServer,
    shouldPreserveCompletedFirstRun: preserveCompleted,
    hadPriorFirstRun: hadPrior,
  };
  // When the desktop shell runs in a non-"local" runtime mode (e.g. "external",
  // pointed at a backend it does NOT host) it has SKIPPED its embedded agent.
  // A loopback backend is otherwise classified "local" → embedded-local, which
  // makes the coordinator run the local agent-readiness poll for an agent that
  // was never started — startup then stalls at starting-runtime forever. Treat
  // it as a remote backend (already running) so the coordinator skips the local
  // poll. Only triggers on desktop when the resolved target is embedded-local
  // AND the shell reports a non-local mode, so local/cloud boots are unchanged.
  let resolvedTarget = activeServerToTarget(restoredActiveServer);
  if (resolvedTarget === "embedded-local" && isElectrobunRuntime()) {
    const runtimeMode = await desktopRuntimeMode();
    if (runtimeMode?.mode && runtimeMode.mode !== "local") {
      resolvedTarget = "remote-backend";
    }
  }
  dispatch({
    type: "SESSION_RESTORED",
    target: resolvedTarget,
  });
}
