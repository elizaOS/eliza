/**
 * startup-phase-restore.ts
 *
 * Side-effect logic for the "restoring-session" startup phase.
 * Probes for an existing install/connection and dispatches the result.
 */

import { logger } from "@elizaos/logger";
import {
  clearStoredStewardToken,
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { client, type FirstRunOptions } from "../api";
import {
  cloudTokenSecsRemaining,
  refreshCloudStewardSession,
} from "../api/client-cloud";
import {
  getBackendStartupTimeoutMs,
  invokeDesktopBridgeRequestWithTimeout,
  isElectrobunRuntime,
  scanProviderCredentials,
} from "../bridge";
import { getBootConfig } from "../config/boot-config";
import {
  ANDROID_LOCAL_AGENT_IPC_BASE,
  ANDROID_LOCAL_AGENT_LABEL,
  ANDROID_LOCAL_AGENT_SERVER_ID,
  IOS_LOCAL_AGENT_IPC_BASE,
  isMobileLocalAgentIpcBase,
  isMobileLocalAgentUrl,
  MOBILE_LOCAL_AGENT_LABEL,
  MOBILE_LOCAL_AGENT_SERVER_ID,
  readPersistedMobileRuntimeMode,
} from "../first-run/mobile-runtime-mode";
import type { UiLanguage } from "../i18n";
import {
  clearForceFreshFirstRun,
  isAndroid,
  isForceFreshFirstRunEnabled,
  isIOS,
  isNative,
} from "../platform";
import type { ExistingElizaInstallInfo } from "../types";
import {
  buildCloudSharedAgentApiBase,
  isElizaCloudControlPlaneAgentlessBase,
  normalizeDirectCloudSharedAgentApiBase,
} from "../utils/cloud-agent-base";
import { getElizaApiBase } from "../utils/eliza-globals";
import { detectExistingFirstRunConnection } from "./first-run-bootstrap";
import {
  clearPersistedActiveServer,
  loadPersistedActiveServer,
  loadPersistedFirstRunComplete,
  type PersistedActiveServer,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "./persistence";
import type { StartupEvent } from "./startup-coordinator";
import { buildStaticFirstRunOptions } from "./startup-first-run-options";

// Direct elizaCloud API base used to backfill a missing apiBase on a
// persisted cloud active-server. Mirrors DEFAULT_DIRECT_CLOUD_API_BASE_URL
// in api/client-cloud.ts; kept inline because that constant is module-private.
const DIRECT_CLOUD_API_BASE = "https://api.elizacloud.ai";
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
/** Steward refresh endpoint path (same-origin on web; `api.` host on native). */
const STEWARD_REFRESH_PATH = "/api/auth/steward-refresh";
/** Default direct Cloud site base used to derive the native refresh endpoint. */
const RESTORE_DEFAULT_DIRECT_CLOUD_BASE_URL = "https://elizacloud.ai";

function isDevUiPort(): boolean {
  return typeof window !== "undefined" && window.location.port === "2138";
}

/**
 * Repair a restored cloud active-server whose apiBase is missing OR is the
 * unusable agent-id-less collection URL (`.../api/v1/eliza/agents`, a broken
 * state from earlier builds that completed firstRun without a per-agent base).
 * Re-derive the per-agent REST adapter base from the persisted `cloud:<agentId>`
 * id — preferring the server-reported url, falling back to deriving it directly
 * from the id. Returns the up-to-date active server, or the input unchanged when
 * no real agent id can be recovered (the startup gate then routes to agent
 * selection instead of dead-ending on "Backend Unreachable").
 */
async function backfillCloudApiBase(
  active: PersistedActiveServer,
): Promise<PersistedActiveServer> {
  if (active.kind !== "cloud") return active;
  // A concrete per-agent base is fine — only act on a missing or id-less base.
  if (
    active.apiBase &&
    !isElizaCloudControlPlaneAgentlessBase(active.apiBase)
  ) {
    return active;
  }
  const rawId = active.id?.startsWith("cloud:")
    ? active.id.slice("cloud:".length).trim()
    : "";
  // A real agent id has no path separators. Older builds mistakenly stored the
  // collection URL itself as the id (`cloud:https://.../agents`) — that can't be
  // recovered here; leave it for the startup gate's agent-selection fallback.
  const agentId = rawId && !rawId.includes("/") ? rawId : null;
  if (!agentId) return active;

  const priorBaseUrl = client.getBaseUrl();
  const priorToken = client.hasToken();
  const derivedApiBase = buildCloudSharedAgentApiBase(
    DIRECT_CLOUD_API_BASE,
    agentId,
  );
  client.setBaseUrl(DIRECT_CLOUD_API_BASE);
  try {
    if (active.accessToken) client.setToken(active.accessToken);
    const res = await client.getCloudCompatAgent(agentId).catch(() => null);
    const data = res?.success ? res.data : null;
    const rawApiBase = data
      ? (data.web_ui_url ?? data.webUiUrl ?? data.bridge_url)
      : null;
    const serverApiBase = rawApiBase
      ? normalizeDirectCloudSharedAgentApiBase(rawApiBase)
      : "";
    // Prefer a concrete server-reported base; otherwise derive from the id.
    const apiBase =
      serverApiBase && !isElizaCloudControlPlaneAgentlessBase(serverApiBase)
        ? serverApiBase
        : derivedApiBase;
    const updated: PersistedActiveServer = { ...active, apiBase };
    savePersistedActiveServer(updated);
    return updated;
  } catch {
    // Even if the lookup fails, never restore the broken base — derive from id.
    const updated: PersistedActiveServer = {
      ...active,
      apiBase: derivedApiBase,
    };
    savePersistedActiveServer(updated);
    return updated;
  } finally {
    // Restore prior client state — applyRestoredConnection sets the final
    // baseUrl below based on the (possibly backfilled) active server.
    client.setBaseUrl(priorBaseUrl || null);
    if (!priorToken) client.setToken(null);
  }
}

export interface RestoringSessionDeps {
  setStartupError: (v: null) => void;
  setAuthRequired: (v: boolean) => void;
  setConnected: (v: boolean) => void;
  setFirstRunExistingInstallDetected: (v: boolean) => void;
  setFirstRunOptions: (v: FirstRunOptions) => void;
  setFirstRunComplete: (v: boolean) => void;
  setFirstRunLoading: (v: boolean) => void;
  applyDetectedProviders: (
    detected: Awaited<ReturnType<typeof scanProviderCredentials>>,
  ) => void;
  forceLocalBootstrapRef: React.MutableRefObject<boolean>;
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

/**
 * Whether a persisted `remote` apiBase is safe to dial at restore. The persisted
 * active-server record lives in localStorage (mirrored to native Preferences),
 * so an XSS or a malicious same-origin plugin view could have written it. Only
 * dial — and attach the bearer token to — a trusted host; otherwise the record
 * is dropped and the app falls back to first-run (fail closed) rather than
 * silently connecting to an attacker-chosen server at boot.
 *
 * Trust mirrors the app's full policy (createUrlTrustPolicy in
 * `packages/app/src/url-trust-policy.ts`, which `@elizaos/ui` cannot import):
 * loopback, the current page origin, and private/LAN/CGNAT/link-local hosts —
 * never an arbitrary public host. Keep the private-host set in sync with
 * `isTrustedPrivateHttpHost` there. `local`/`cloud` records use their own
 * validated branches in {@link applyRestoredConnection} and are not gated here.
 */
export function isTrustedRestoreApiBaseUrl(
  apiBase: string | undefined,
): boolean {
  if (!apiBase) return false;
  // The bundled on-device agent's IPC pseudo-base (eliza-local-agent://ipc) is
  // in-process: no network dial, no attacker-choosable host, no bearer-token
  // exfiltration surface. Its custom scheme fails the http/https gate below,
  // and without this allowance EVERY relaunch of a local-mode phone dropped
  // its saved on-device server and silently un-completed first-run (the iOS
  // boot-to-onboarding bounce found via the #11110 device boot trace).
  if (isMobileLocalAgentIpcBase(apiBase)) return true;
  let parsed: URL;
  try {
    parsed = new URL(apiBase);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHostname(host) || host === "0.0.0.0") return true;
  if (
    typeof window !== "undefined" &&
    host === window.location.hostname.toLowerCase()
  ) {
    return true;
  }
  // IPv6 ULA (fc00::/7) / link-local (fe80::/10).
  if (
    host.includes(":") &&
    (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:"))
  ) {
    return true;
  }
  // RFC1918 / CGNAT (tailscale) / link-local IPv4 + private name suffixes.
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^169\.254\.\d{1,3}\.\d{1,3}$/.test(host) ||
    host === "local" ||
    host === "internal" ||
    host === "lan" ||
    host === "ts.net" ||
    host.endsWith(".local") ||
    host.endsWith(".lan") ||
    host.endsWith(".internal") ||
    host.endsWith(".ts.net")
  );
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
  if (mobileLocal && mobileRuntimeMode !== "local") {
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

async function inspectExistingElizaInstallForStartup(): Promise<ExistingElizaInstallInfo | null> {
  const result =
    await invokeDesktopBridgeRequestWithTimeout<ExistingElizaInstallInfo>({
      rpcMethod: "agentInspectExistingInstall",
      ipcChannel: "agent:inspectExistingInstall",
      timeoutMs: DESKTOP_RESTORE_RPC_TIMEOUT_MS,
    });
  return result.status === "ok" ? result.value : null;
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
 * Native (`capacitor://localhost`) has no same-origin cookie, so refresh against
 * the configured Cloud API base (Bearer-refresh). Mirrors
 * `resolveStewardRefreshEndpoint` in `state/useCloudState.ts`.
 */
function resolveRestoreStewardRefreshEndpoint(): string | undefined {
  if (!isNative) return undefined;
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
  if (!stored) return null;
  const secs = cloudTokenSecsRemaining(stored);
  // Opaque/device-code token (no decodable `exp`) → nothing to refresh.
  if (secs === null) return stored;
  // Comfortably valid → restore instantly.
  if (secs >= STEWARD_RESTORE_REFRESH_AHEAD_SECS) return stored;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const refreshed = await Promise.race([
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
      // best-effort — listeners re-read on their next tick regardless
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
    const resolved = await backfillCloudApiBase(restoredActiveServer);
    clientRef.setBaseUrl(resolved.apiBase ?? null);
    // Cloud = Steward everywhere (DECISIONS.md D3): prefer the live Steward
    // session token over the token captured at provision time (which may have
    // rotated since). If that stored JWT expired while the app was closed,
    // refresh it BEFORE handing it to the client so a returning user never
    // boots into a permanently-401ing session (see resolveRestoredStewardToken).
    const stewardToken = await resolveRestoredStewardToken();
    clientRef.setToken(stewardToken || resolved.accessToken || null);
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
  forceLocal: boolean;
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
    return args.forceLocal || args.isDesktop || args.clientApiAvailable;
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
  deps.setFirstRunExistingInstallDetected(false);

  const forceLocal = deps.forceLocalBootstrapRef.current;
  deps.forceLocalBootstrapRef.current = false;
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

  const desktopInstall =
    !forceFreshFirstRun && !persistedActiveServer && isElectrobunRuntime()
      ? await inspectExistingElizaInstallForStartup().catch(() => null)
      : null;
  if (cancelled.current) return;

  const isDesktop = forceLocal || isElectrobunRuntime();
  const _hasExistingEvidence = hadPrior || Boolean(desktopInstall?.detected);

  // Probe the API when there is evidence of a prior install, or when no
  // persisted server exists (covers headless/VPS setups where config was
  // set via files without going through UI firstRun).
  const probed =
    !forceFreshFirstRun && !persistedActiveServer && !isDevUiPort()
      ? await detectExistingFirstRunConnection({
          client,
          timeoutMs: isDesktop
            ? Math.min(getBackendStartupTimeoutMs(), 30_000)
            : Math.min(getBackendStartupTimeoutMs(), 3_500),
        })
      : null;
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
      forceLocal,
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
    hadPrior && !deps.firstRunCompletionCommittedRef.current;

  deps.setFirstRunExistingInstallDetected(
    forceFreshFirstRun
      ? false
      : Boolean(
          hadPrior ||
            desktopInstall?.detected ||
            probed?.detectedExistingInstall,
        ),
  );

  if (!restoredActiveServer) {
    // No saved backend found — let the user (re-)onboard.
    deps.setFirstRunOptions(buildStaticFirstRunOptions(deps.uiLanguage));
    if (!forceFreshFirstRun) {
      try {
        const det = await scanProviderCredentials();
        if (!cancelled.current && det.length > 0) {
          deps.applyDetectedProviders(det);
        }
      } catch {
        // keychain scan is best-effort; proceed with fresh firstRun
      }
    }
    deps.setFirstRunComplete(false);
    deps.setFirstRunLoading(false);
    dispatch({ type: "NO_SESSION", hadPriorFirstRun: hadPrior });
    return;
  }

  await applyRestoredConnection({
    restoredActiveServer,
    clientRef: client,
    startLocalRuntime: async () => {
      try {
        const runtimeMode = await getDesktopRuntimeModeForStartup().catch(
          () => null,
        );
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
    const runtimeMode = await getDesktopRuntimeModeForStartup().catch(
      () => null,
    );
    if (runtimeMode?.mode && runtimeMode.mode !== "local") {
      resolvedTarget = "remote-backend";
    }
  }
  dispatch({
    type: "SESSION_RESTORED",
    target: resolvedTarget,
  });
}
