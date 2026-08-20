/**
 * Restores a persisted runtime target and its credential before startup probes
 * begin. Cloud control-plane sessions and agent-local paired sessions remain
 * separate even when both are represented by a cloud runtime profile.
 */

import { logger } from "@elizaos/logger";
import {
  isCloudPairAgentId,
  isCloudPairLoopbackOrigin,
} from "@elizaos/shared/contracts";
import {
  clearStoredStewardToken,
  hasStewardAuthedCookie,
  readStoredStewardToken,
  STEWARD_TOKEN_KEY,
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
import { normalizeCloudApiKeyToken } from "../cloud/lib/cloud-api-key-token";
import { getBootConfig } from "../config/boot-config";
import {
  ANDROID_LOCAL_AGENT_IPC_BASE,
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  IOS_LOCAL_AGENT_IPC_BASE,
  isCommittedOnDeviceMobileRuntimeMode,
  isMobileLocalAgentIpcUrl,
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
  wasForceFreshResetApplied,
} from "../platform";
import { loadRuntimeCredential } from "../platform/runtime-credential-store";
import { isViteDevUiShell } from "../platform/vite-dev-ui-shell";
import {
  buildCloudSharedAgentApiBase,
  buildDedicatedCloudAgentApiBase,
  dedicatedCloudAgentIdFromBase,
  isDedicatedCloudAgentBase,
  isElizaCloudControlPlaneAgentlessBase,
  isManagedCloudSharedAgentBase,
  isPersonalSharedElizaId,
  resolveCloudEnvironmentBase,
} from "../utils/cloud-agent-base";
import { getElizaApiBase, getElizaApiToken } from "../utils/eliza-globals";
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
import { migrateLegacyRuntimeCredentials } from "./runtime-credential-migration";
import {
  isTrustedCloudApiBaseUrl,
  isTrustedRestoreApiBaseUrl,
} from "./runtime-url-trust";
import { clearSharedCloudAccountBinding } from "./shared-cloud-account-binding";
import type { StartupEvent } from "./startup-coordinator";
import { buildStaticFirstRunOptions } from "./startup-first-run-options";
import { runStartupProbeWithTimeout } from "./startup-probe";
import { STARTUP_TIMING_POLICY } from "./startup-timing-policy";

const DESKTOP_RESTORE_RPC_TIMEOUT_MS =
  STARTUP_TIMING_POLICY.desktopRestoreRpcTimeoutMs;

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
const STEWARD_RESTORE_REFRESH_TIMEOUT_MS =
  STARTUP_TIMING_POLICY.stewardRestoreRefreshTimeoutMs;
/** Bound the non-blocking legacy runtime-tier repair lookup. */
const CLOUD_AGENT_TIER_PROBE_TIMEOUT_MS =
  STARTUP_TIMING_POLICY.cloudAgentTierProbeTimeoutMs;
/** Steward refresh endpoint path (same-origin on web; `api.` host on native). */
const STEWARD_REFRESH_PATH = "/api/auth/steward-refresh";
/** Default direct Cloud site base used to derive the native refresh endpoint. */
const RESTORE_DEFAULT_DIRECT_CLOUD_BASE_URL = "https://eliza.app";

function recoverCloudAgentId(active: PersistedActiveServer): string | null {
  const runtimeId = active.cloudRuntimeAgentId?.trim() ?? "";
  if (isCloudPairAgentId(runtimeId) || isPersonalSharedElizaId(runtimeId)) {
    return runtimeId;
  }
  const rawId = active.id?.startsWith("cloud:")
    ? active.id.slice("cloud:".length).trim()
    : "";
  if (isCloudPairAgentId(rawId) || isPersonalSharedElizaId(rawId)) return rawId;
  const baseAgentId = dedicatedCloudAgentIdFromBase(active.apiBase);
  return isCloudPairAgentId(baseAgentId) ? baseAgentId : null;
}

/**
 * Repair an older persisted dedicated-looking base when the owner record says
 * it is actually a temporary shared bridge. This runs off the startup critical
 * path: an inconclusive lookup leaves the already-bound target untouched.
 */
async function reconcileLegacyDedicatedCloudApiBase(
  active: PersistedActiveServer,
  ownerToken: string | null,
): Promise<PersistedActiveServer | null> {
  if (!ownerToken || !isDedicatedCloudAgentBase(active.apiBase)) return null;
  const agentId = recoverCloudAgentId(active);
  if (!agentId) return null;
  const pageHostname =
    typeof window !== "undefined" ? window.location.hostname : "";
  const cloudApiBase = resolveDirectCloudAuthApiBase(
    resolveCloudEnvironmentBase({
      pageHostname,
      apiBase: active.apiBase,
      bootCloudApiBase: getBootConfig().cloudApiBase,
      fallback: RESTORE_DEFAULT_DIRECT_CLOUD_BASE_URL,
    }),
  );
  try {
    const response = await fetch(
      `${cloudApiBase}/api/v1/eliza/agents/${encodeURIComponent(agentId)}`,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${ownerToken}`,
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
 *
 * Environment priority for dedicated ingress rebuild:
 * live Cloud page host → already-staging persisted base → boot config → prod
 * default. Agent-subdomain UI bundles ship the production boot default, so
 * trusting boot alone rewrote staging dedicated hosts onto production and
 * CORS-wedged `/api/*` probes during restore.
 */
function backfillCloudApiBase(
  active: PersistedActiveServer,
): PersistedActiveServer {
  if (active.kind !== "cloud") return active;
  const agentId = recoverCloudAgentId(active);
  if (!agentId) return active;
  const pageHostname =
    typeof window !== "undefined" ? window.location.hostname : "";
  const cloudApiBase = resolveCloudEnvironmentBase({
    pageHostname,
    apiBase: active.apiBase,
    bootCloudApiBase: getBootConfig().cloudApiBase,
    fallback: RESTORE_DEFAULT_DIRECT_CLOUD_BASE_URL,
  });
  // When the user is already on this agent's dedicated ingress, keep that
  // origin — do not rebuild through a mismatched boot-config environment.
  const pageOrigin =
    typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.host}`
      : "";
  const pageAgentId = pageOrigin
    ? dedicatedCloudAgentIdFromBase(pageOrigin)
    : null;
  const dedicatedApiBase = isCloudPairAgentId(agentId)
    ? pageAgentId && pageAgentId.toLowerCase() === agentId.toLowerCase()
      ? pageOrigin
      : buildDedicatedCloudAgentApiBase(agentId, cloudApiBase)
    : null;
  const sharedApiBase = buildCloudSharedAgentApiBase(
    resolveDirectCloudAuthApiBase(cloudApiBase),
    agentId,
  );
  const managedBase =
    !active.apiBase ||
    isElizaCloudControlPlaneAgentlessBase(active.apiBase) ||
    isDirectCloudSharedAgentBase(active.apiBase) ||
    isDedicatedCloudAgentBase(active.apiBase);
  // Unknown hosts remain structurally unchanged here so the restore trust gate
  // can reject them without fabricating a canonical server-owned address.
  if (!managedBase) return active;

  const useSharedApiBase =
    active.cloudRuntime === "shared" ||
    isDirectCloudSharedAgentBase(active.apiBase);
  const repairedApiBase = useSharedApiBase ? sharedApiBase : dedicatedApiBase;
  if (!repairedApiBase) return active;
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

function isMobileLocalActiveServer(
  server: PersistedActiveServer,
  mobileRuntimeMode = readPersistedMobileRuntimeMode(),
): boolean {
  if (server.kind === "local" || isMobileLocalAgentIpcUrl(server.apiBase)) {
    return true;
  }

  // The remote-Mac developer target deliberately reuses the desktop agent's
  // loopback identity inside Simulator. Runtime mode is therefore the owner of
  // that ambiguous URL: treating it as bundled IPC clears the saved server and
  // boots the iOS Bun runtime on every cold launch.
  if (mobileRuntimeMode === "remote-mac") return false;

  return isMobileLocalAgentApiBase(server.apiBase);
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
  const mobileLocal = isMobileLocalActiveServer(server, mobileRuntimeMode);
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
    return `${resolveDirectCloudAuthApiBase(cloudBase)}${STEWARD_REFRESH_PATH}`;
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
    // No app-origin token, but the host-only Eliza session
    // cookie is present — the user signed in on the console (or another
    // managed Eliza tab). Recover the access token from it (bounded, same as
    // the /login page) instead of forcing a redundant re-sign-in; on success
    // the top-level LoginView gate and the first-run conductor both skip.
    if (typeof window !== "undefined" && hasStewardAuthedCookie()) {
      const refreshProbe = await runStartupProbeWithTimeout(
        () =>
          refreshCloudStewardSession({
            endpoint: resolveRestoreStewardRefreshEndpoint(),
          }),
        STEWARD_RESTORE_REFRESH_TIMEOUT_MS,
      );
      const recovered = refreshProbe.kind === "ok" ? refreshProbe.value : null;
      if (refreshProbe.kind !== "ok") {
        logger.warn(
          { error: refreshProbe.error, kind: refreshProbe.kind },
          "[startup-phase-restore] Steward cookie refresh did not complete",
        );
      }
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

  const refreshProbe = await runStartupProbeWithTimeout(
    () =>
      refreshCloudStewardSession({
        endpoint: resolveRestoreStewardRefreshEndpoint(),
      }),
    STEWARD_RESTORE_REFRESH_TIMEOUT_MS,
  );
  const refreshed = refreshProbe.kind === "ok" ? refreshProbe.value : null;
  if (refreshProbe.kind !== "ok") {
    logger.warn(
      { error: refreshProbe.error, kind: refreshProbe.kind },
      "[startup-phase-restore] stored Steward token refresh did not complete",
    );
  }

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
    clearSharedCloudAccountBinding();
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
    // Environment reconciliation is synchronous. The selected target's known
    // credential is cleared before the base changes, then the selected record's
    // known credential is installed. A slower Steward refresh may replace it.
    // Never send an agent-local paired token to the Cloud control plane. A
    // refreshed Steward session, or the native host's Cloud owner key, is the
    // valid authority for this owner lookup.
    const resolved = backfillCloudApiBase(restoredActiveServer);
    const agentId = recoverCloudAgentId(resolved);
    if (!isTrustedCloudApiBaseUrl(resolved.apiBase, agentId)) {
      logger.warn(
        `[startup-phase-restore] dropping persisted cloud active-server with untrusted apiBase host: ${resolved.apiBase ?? "(none)"}`,
      );
      clearPersistedActiveServer();
      clientRef.setToken(null);
      clientRef.setBaseUrl(null);
      return;
    }
    const restoreProbeToken = readStoredStewardToken()?.trim() || null;
    // Capture the host-injected owner key before clientRef.setToken(null)
    // mutates boot config. Native/Electrobun device-code sessions may have no
    // persisted active-server token and rely exclusively on this credential.
    const nativeOwnerApiKey =
      isNative || isElectrobunRuntime()
        ? (normalizeCloudApiKeyToken(resolved.accessToken) ??
          normalizeCloudApiKeyToken(getElizaApiToken()))
        : null;
    const usesLocalDockerCredential = isCloudPairLoopbackOrigin(
      resolved.apiBase,
    );
    const isAgentlessControlPlane = isElizaCloudControlPlaneAgentlessBase(
      resolved.apiBase,
    );
    const initialToken = usesLocalDockerCredential
      ? resolved.accessToken || null
      : isAgentlessControlPlane
        ? restoreProbeToken
        : resolved.accessToken || restoreProbeToken || null;
    clientRef.setToken(null);
    clientRef.setBaseUrl(resolved.apiBase ?? null);
    clientRef.setToken(initialToken);
    let stewardTokenPromise: Promise<string | null>;
    if (nativeOwnerApiKey && restoreProbeToken) {
      const secs = cloudTokenSecsRemaining(restoreProbeToken);
      if (secs !== null && secs < STEWARD_RESTORE_REFRESH_AHEAD_SECS) {
        // A near-expiry Steward JWT would shadow the valid owner-key fallback.
        // Try rotation once; on failure remove only that JWT so native Cloud
        // requests continue with the independently valid owner key.
        stewardTokenPromise = refreshCloudStewardSession()
          .then((refreshed) => {
            const fresh = refreshed?.token?.trim() || null;
            if (fresh) writeStoredStewardToken(fresh);
            else if (typeof window !== "undefined")
              window.localStorage.removeItem(STEWARD_TOKEN_KEY);
            return fresh;
          })
          .catch(() => {
            // error-policy:J4 the valid native owner key remains available;
            // remove the shadowing near-expiry JWT and visibly continue with it.
            if (typeof window !== "undefined")
              window.localStorage.removeItem(STEWARD_TOKEN_KEY);
            return null;
          });
      } else {
        stewardTokenPromise = Promise.resolve(restoreProbeToken);
      }
    } else {
      stewardTokenPromise = nativeOwnerApiKey
        ? Promise.resolve(null)
        : resolveRestoredStewardToken();
    }
    // Cloud = Steward everywhere (DECISIONS.md D3): prefer the live Steward
    // session token over the token captured at provision time (which may have
    // rotated since). If that stored JWT expired while the app was closed,
    // refresh it BEFORE handing it to the client so a returning user never
    // boots into a permanently-401ing session (see resolveRestoredStewardToken).
    const stewardToken = await stewardTokenPromise;
    if (
      isManagedCloudSharedAgentBase(resolved.apiBase) &&
      !stewardToken &&
      !nativeOwnerApiKey
    ) {
      // Terminal refresh failure or a missing account session makes the saved
      // shared target unsafe. Clear every account-scoped mirror before startup
      // can reinstall the provision-time token or poll the previous agent.
      clearSharedCloudAccountBinding();
      clientRef.setToken(null);
      clientRef.setBaseUrl(null);
      return;
    }
    // The compatibility lookup must use the post-refresh authority. The stored
    // pre-refresh JWT can be expired, while native/Electrobun restores may
    // intentionally rely on a host-injected Cloud owner key instead.
    const controlPlaneOwnerToken = stewardToken ?? nativeOwnerApiKey;
    const tierRepairPromise = isDedicatedCloudAgentBase(
      restoredActiveServer.apiBase,
    )
      ? reconcileLegacyDedicatedCloudApiBase(resolved, controlPlaneOwnerToken)
      : Promise.resolve(null);
    // Dedicated agent subdomains and explicit local-Docker pair targets use an
    // agent-local bearer for `/api/*`. The edge-owned dedicated path can keep
    // its Steward recovery fallback; a loopback process must never receive a
    // Cloud control-plane credential when its paired bearer is absent.
    clientRef.setToken(
      usesLocalDockerCredential
        ? resolved.accessToken || null
        : isDedicatedCloudAgentBase(resolved.apiBase)
          ? resolved.accessToken || stewardToken || null
          : isAgentlessControlPlane
            ? stewardToken || nativeOwnerApiKey || null
            : stewardToken || nativeOwnerApiKey || resolved.accessToken || null,
    );
    void tierRepairPromise.then((repaired) => {
      if (!repaired || repaired.apiBase === resolved.apiBase) return;
      if (!isTrustedCloudApiBaseUrl(repaired.apiBase, agentId)) return;
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
      clientRef.setToken(null);
      clientRef.setBaseUrl(repaired.apiBase ?? null);
      // A shared adapter is a Cloud control-plane target. The same owner
      // authority that proved the tier must remain installed after rerouting.
      clientRef.setToken(controlPlaneOwnerToken);
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
  clientRef.setToken(null);
  clientRef.setBaseUrl(reconciled ?? null);
  const restoredCredential =
    restoredActiveServer.accessToken ??
    (restoredActiveServer.credentialRef
      ? await loadRuntimeCredential(restoredActiveServer.credentialRef)
      : null);
  clientRef.setToken(restoredCredential ?? null);
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
    // A remote or Cloud record with an untrusted apiBase host must not be restored —
    // restoring it would dial an attacker-chosen server with the persisted
    // bearer token. Untrusted → not restorable → the caller clears it and falls
    // back to first-run. local/cloud branches validate their own hosts.
    if (args.server.kind === "remote") {
      return isTrustedRestoreApiBaseUrl(args.server.apiBase);
    }
    if (args.server.kind === "cloud") {
      return isTrustedCloudApiBaseUrl(
        args.server.apiBase,
        recoverCloudAgentId(args.server),
      );
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
    return (
      isCloudPairAgentId(args.server.cloudRuntimeAgentId) ||
      isPersonalSharedElizaId(args.server.cloudRuntimeAgentId ?? "") ||
      isCloudPairAgentId(rawId) ||
      isPersonalSharedElizaId(rawId)
    );
  }

  return false;
}

function preserveCloudAuthTokenForFirstRun(
  server: PersistedActiveServer,
): void {
  if (server.kind !== "cloud") return;
  // Only the independent Steward store is safe to carry to the control plane.
  // A rejected Cloud record's access token may be an agent-local pair bearer.
  const token = readStoredStewardToken()?.trim() || null;
  client.setToken(null);
  client.setBaseUrl(
    resolveDirectCloudAuthApiBase(
      getBootConfig().cloudApiBase || RESTORE_DEFAULT_DIRECT_CLOUD_BASE_URL,
    ),
  );
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
  await migrateLegacyRuntimeCredentials();
  if (cancelled.current) return;
  let persistedActiveServer = loadPersistedActiveServer();
  let hadPrior = loadPersistedFirstRunComplete();
  const forceFreshFirstRun = isForceFreshFirstRunEnabled();
  if (forceFreshFirstRun) {
    const resetAlreadyClearedPriorServer = wasForceFreshResetApplied();
    // force-fresh is a ONE-SHOT directive: it forces exactly one fresh
    // onboarding after an escape hatch (unreachable backend, pairing dead-end,
    // ?reset). Clear it the moment restore consumes it so the *next* launch is
    // back to normal server-authoritative behavior. Previously it was only
    // cleared by the submitFirstRun client patch, so any completion path that
    // doesn't POST first-run (cloud shared-agent's swallowed 404, pairing
    // early-return) left the flag set — re-onboarding the user on every launch.
    clearForceFreshFirstRun();
    // `?reset` clears the old target synchronously before the app mounts. If a
    // connect deep link establishes a server after that point, it is newer user
    // intent and must survive this later restore pass. A reset initiated by
    // startFreshFirstRunReload has no applied marker, so it retains the original
    // behavior and clears the pre-existing server here.
    const preservePostResetConnection =
      resetAlreadyClearedPriorServer && persistedActiveServer !== null;
    if (!preservePostResetConnection) {
      clearPersistedActiveServer();
      savePersistedFirstRunComplete(false);
      persistedActiveServer = null;
      hadPrior = false;
      deps.firstRunCompletionCommittedRef.current = false;
      client.setBaseUrl(null);
      client.setToken(null);
    }
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
    !forceFreshFirstRun && !persistedActiveServer && !isViteDevUiShell();
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

  if (
    isManagedCloudSharedAgentBase(restoredActiveServer.apiBase) &&
    !loadPersistedActiveServer()
  ) {
    deps.setFirstRunOptions(buildStaticFirstRunOptions(deps.uiLanguage));
    deps.setFirstRunComplete(false);
    deps.setFirstRunLoading(false);
    dispatch({ type: "NO_SESSION", hadPriorFirstRun: hadPrior });
    return;
  }

  // The connection is applied (base URL + token are what the post-paint auth
  // gate will use), so start the /api/auth/me probe now — it overlaps the
  // polling/hydration phases instead of serializing after first paint. See
  // primeAuthStatusProbe for why a mid-boot 503 outcome is discarded.
  // Skip the prime for a credential-less remote/cloud restore: /api/auth/me
  // cannot answer authoritatively without a bearer token, and the poll phase
  // may route that restore to pairing-required (which never mounts the shell,
  // so the post-paint hook — which covers every painted path — never fires).
  if (
    restoredActiveServer.kind === "local" ||
    restoredActiveServer.accessToken ||
    getElizaApiToken()
  ) {
    primeAuthStatusProbe();
  }

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
