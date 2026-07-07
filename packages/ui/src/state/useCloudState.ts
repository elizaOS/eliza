/**
 * Eliza Cloud state, one of the domain hooks AppContext composes.
 *
 * Manages:
 * - Cloud connection state (enabled, connected, persisted key, user ID)
 * - Credits state (balance, low/critical thresholds, errors, top-up URL)
 * - Login / disconnect flow (busy flags, error messages, poll timers)
 * - Cloud dashboard view preference
 * - Auth-rejected notice effect
 *
 * Cross-domain dependencies accepted as params:
 * - `setActionNotice`        — from useLifecycleState, used for disconnect / auth notices
 * - `loadWalletConfig`       — from useWalletState, called after successful login
 * - `t`                      — translation function, used for auth-rejected notice key
 */

import { logger } from "@elizaos/logger";
import {
  clearStoredStewardToken,
  readStoredStewardToken,
  writeStoredStewardToken,
} from "@elizaos/shared/steward-session-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../api";
import { supportsFullAppShellRoutes } from "../api/app-shell-capabilities";
import {
  cloudTokenSecsRemaining,
  refreshCloudStewardSession,
} from "../api/client-cloud";
import {
  invokeDesktopBridgeRequestWithTimeout,
  isElectrobunRuntime,
} from "../bridge";
import { clearStaleStewardSession } from "../cloud/shell/StewardProviderShared";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import { dispatchElizaCloudStatusUpdated } from "../events";
import { isElizaCloudRuntimeLocked } from "../first-run/mobile-runtime-mode";
import {
  closeExternalBrowser,
  confirmDesktopAction,
  isCloudStatusAuthenticated,
  navigatePreOpenedWindow,
  openExternalUrl,
  yieldHttpAfterNativeMessageBox,
} from "../utils";
import { scrubPersistedAgentProfileTokens } from "./agent-profiles";
import {
  navigateToSameTabCloudLogin,
  shouldUseSameTabCloudLogin,
} from "./cloud-login-launch";
import {
  getInjectedEthereumProvider,
  siweLoginWithInjectedWallet,
} from "./cloud-siwe-login";
import {
  hasStewardLoginLauncher,
  hasUsableStoredStewardToken,
  launchStewardLogin,
} from "./cloud-steward-login";
import { scrubPersistedActiveServerToken } from "./persistence";
import { isPrivateNetworkHost } from "./private-network-host";

// ── Constants ──────────────────────────────────────────────────────────────

const ELIZA_CLOUD_LOGIN_POLL_INTERVAL_MS = 1000;
const ELIZA_CLOUD_LOGIN_TIMEOUT_MS = 300_000;
const ELIZA_CLOUD_LOGIN_MAX_CONSECUTIVE_ERRORS = 3;
const DEFAULT_DIRECT_CLOUD_BASE_URL = "https://elizacloud.ai";

/** Cloud=Steward token-lifecycle: how often to check the JWT for expiry. */
const STEWARD_REFRESH_CHECK_INTERVAL_MS = 60_000;
/** Refresh the Steward session this many seconds before the JWT `exp`. */
const STEWARD_REFRESH_AHEAD_SECS = 120;
/** Same-origin Steward refresh endpoint (web cookie path). */
const STEWARD_REFRESH_PATH = "/api/auth/steward-refresh";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Publish server cloud snapshot for chat TTS (`useVoiceChat` + `loadVoiceConfig`). */
function publishElizaCloudVoiceSnapshot(
  setHasPersistedKey: (value: boolean) => void,
  snapshot: {
    apiConnected: boolean;
    enabled: boolean;
    cloudVoiceProxyAvailable: boolean;
    hasPersistedApiKey: boolean;
  },
): void {
  setHasPersistedKey(snapshot.hasPersistedApiKey);
  dispatchElizaCloudStatusUpdated({
    connected: snapshot.apiConnected,
    enabled: snapshot.enabled,
    hasPersistedApiKey: snapshot.hasPersistedApiKey,
    cloudVoiceProxyAvailable: snapshot.cloudVoiceProxyAvailable,
  });
}

function isSameOriginLocalHttpBackend(): boolean {
  if (typeof window === "undefined") {
    return false;
  }

  const { hostname, protocol } = window.location;
  if (protocol !== "http:" && protocol !== "https:") {
    return false;
  }

  return isPrivateNetworkHost(hostname);
}

function isDevUiPortWithoutEmbeddedBackend(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.port === "2138";
}

function isCapacitorNativeRuntime(): boolean {
  if (typeof globalThis === "undefined") return false;
  const capacitor = (
    globalThis as {
      Capacitor?: {
        isNativePlatform?: () => boolean;
      };
    }
  ).Capacitor;
  return Boolean(capacitor?.isNativePlatform?.());
}

function originsMatch(left: string, right: string): boolean {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    // error-policy:J3 malformed URL input fails closed (no origin match).
    return false;
  }
}

function isConfiguredCloudSiteBase(baseUrl: string): boolean {
  const configuredCloudBase =
    getBootConfig().cloudApiBase?.trim() || DEFAULT_DIRECT_CLOUD_BASE_URL;
  if (originsMatch(baseUrl, configuredCloudBase)) return true;

  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return (
      host === "api.elizacloud.ai" ||
      host === "elizacloud.ai" ||
      host === "www.elizacloud.ai" ||
      host === "dev.elizacloud.ai"
    );
  } catch {
    // error-policy:J3 malformed base URL fails closed (not a cloud site base).
    return false;
  }
}

function isCapacitorAssetBase(baseUrl: string): boolean {
  if (!isCapacitorNativeRuntime()) return false;
  try {
    const parsed = new URL(baseUrl);
    if (parsed.pathname !== "/" || parsed.search || parsed.hash) return false;
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.hostname.toLowerCase() === "localhost" &&
      parsed.port === ""
    );
  } catch {
    // error-policy:J3 malformed base URL fails closed (not the asset base).
    return false;
  }
}

function hasCloudLoginBackend(): boolean {
  if (isCapacitorNativeRuntime()) return false;

  const explicitBase =
    typeof client.getBaseUrl === "function" ? client.getBaseUrl().trim() : "";
  if (explicitBase) {
    return (
      !isConfiguredCloudSiteBase(explicitBase) &&
      !isCapacitorAssetBase(explicitBase)
    );
  }
  if (isDevUiPortWithoutEmbeddedBackend()) return false;
  return isSameOriginLocalHttpBackend();
}

function canPollCloudStatus(): boolean {
  const explicitBase =
    typeof client.getBaseUrl === "function" ? client.getBaseUrl().trim() : "";
  if (isCapacitorNativeRuntime()) return true;
  if (explicitBase && isConfiguredCloudSiteBase(explicitBase)) return true;
  return hasCloudLoginBackend() && supportsFullAppShellRoutes(explicitBase);
}

/**
 * Resolve the Steward refresh endpoint for the current target. On hosted web
 * the same-origin cookie path works (the HttpOnly `steward-refresh-token`
 * cookie travels automatically). On native/Electrobun there is no same-origin
 * cookie, so refresh against the configured cloud API base (Bearer-refresh).
 * Returns `undefined` to use the shared default.
 */
function resolveStewardRefreshEndpoint(): string | undefined {
  if (!isCapacitorNativeRuntime() && !isElectrobunRuntime()) return undefined;
  const cloudBase =
    getBootConfig().cloudApiBase?.trim() || DEFAULT_DIRECT_CLOUD_BASE_URL;
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
    // error-policy:J3 malformed cloud base URL → use the shared default
    // refresh endpoint (the documented `undefined` contract of this helper).
    return undefined;
  }
}

// ── Types ──────────────────────────────────────────────────────────────────

interface CloudStateParams {
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
    once?: boolean,
    busy?: boolean,
  ) => void;
  /** From useWalletState — called after successful cloud login to reload wallet. */
  loadWalletConfig: () => Promise<void>;
  /** Translation function — used for the auth-rejected notice. */
  t: (key: string) => string;
  /** Product/runtime policy can lock cloud auth on, hiding disconnect affordances. */
  disconnectLocked?: boolean;
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useCloudState({
  setActionNotice,
  loadWalletConfig,
  t,
  disconnectLocked = false,
}: CloudStateParams) {
  // ── State ──────────────────────────────────────────────────────────

  const [elizaCloudEnabled, setElizaCloudEnabled] = useState(false);
  const [elizaCloudVoiceProxyAvailable, setElizaCloudVoiceProxyAvailable] =
    useState(false);
  const [elizaCloudConnected, setElizaCloudConnected] = useState(false);
  const [elizaCloudHasPersistedKey, setElizaCloudHasPersistedKey] =
    useState(false);
  const [elizaCloudCredits, setElizaCloudCredits] = useState<number | null>(
    null,
  );
  const [elizaCloudCreditsLow, setElizaCloudCreditsLow] = useState(false);
  const [elizaCloudCreditsCritical, setElizaCloudCreditsCritical] =
    useState(false);
  const [elizaCloudAuthRejected, setElizaCloudAuthRejected] = useState(false);
  const [elizaCloudCreditsError, setElizaCloudCreditsError] = useState<
    string | null
  >(null);
  const [elizaCloudTopUpUrl, setElizaCloudTopUpUrl] =
    useState("/cloud/billing");
  const [elizaCloudUserId, setElizaCloudUserId] = useState<string | null>(null);
  const [elizaCloudStatusReason, setElizaCloudStatusReason] = useState<
    string | null
  >(null);
  const [cloudDashboardView, setCloudDashboardView] = useState<
    "overview" | "billing"
  >("overview");
  const [elizaCloudLoginBusy, setElizaCloudLoginBusy] = useState(false);
  const [elizaCloudLoginError, setElizaCloudLoginError] = useState<
    string | null
  >(null);
  /**
   * Verification URL returned by `POST /api/cloud/login`, shown to the user
   * as a manual fallback while the device-code flow is awaiting completion.
   *
   * The renderer also tries to open this URL automatically via
   * `openExternalUrl()` (Capacitor / Electrobun / window.open), but on some
   * desktops the system handler is wired to a browser that silently fails
   * to surface a window — e.g. Tails routes `xdg-open` through gtk-launch
   * to the Tor Browser flatpak, and if Tor has not bootstrapped yet the
   * browser hangs on its splash screen with no visible feedback in the
   * renderer. Always exposing the URL as a copyable link lets the user
   * complete sign-in on any device with internet access, matching the
   * standard OAuth device-code UX (gh auth login, npm login, stripe login).
   *
   * Set to a string when the cloud-login session is created, cleared when
   * polling stops (authenticated, errored, timed out, or user cancelled).
   */
  const [elizaCloudLoginFallbackUrl, setElizaCloudLoginFallbackUrl] = useState<
    string | null
  >(null);
  const [elizaCloudDisconnecting, setElizaCloudDisconnecting] = useState(false);

  // ── Refs ───────────────────────────────────────────────────────────

  /** Recurring interval that polls cloud credits every 60s while connected. */
  const elizaCloudPollInterval = useRef<number | null>(null);
  /** While true, ignore stale poll results (in-flight GETs may predate POST /api/cloud/disconnect). */
  const elizaCloudDisconnectInFlightRef = useRef(false);
  /**
   * After the user disconnects, keep the "Connect Eliza Cloud" screen until they start
   * login again, even if GET /api/cloud/status still reports `connected: true` (laggy
   * snapshot or proxy mismatch).
   */
  const elizaCloudPreferDisconnectedUntilLoginRef = useRef(false);
  /** Last `connected` applied by pollCloudCredits; used when a poll is skipped mid-flight. */
  const lastElizaCloudPollConnectedRef = useRef(false);
  /** Short-lived polling interval used during the browser-based login flow. */
  const elizaCloudLoginPollTimer = useRef<number | null>(null);
  const elizaCloudLoginCompletionRef = useRef<Promise<void> | null>(null);
  /** Synchronous lock to prevent duplicate login clicks in the same tick. */
  const elizaCloudLoginBusyRef = useRef(false);
  /** Tracks whether the auth-rejected notice has already been sent for the current rejection. */
  const elizaCloudAuthNoticeSentRef = useRef(false);

  // ── Callbacks ──────────────────────────────────────────────────────

  const pollCloudCredits = useCallback(async (): Promise<boolean> => {
    if (!canPollCloudStatus()) {
      if (elizaCloudPollInterval.current) {
        clearInterval(elizaCloudPollInterval.current);
        elizaCloudPollInterval.current = null;
      }
      return lastElizaCloudPollConnectedRef.current;
    }
    if (elizaCloudDisconnectInFlightRef.current) {
      return lastElizaCloudPollConnectedRef.current;
    }
    // error-policy:J4 transient poll failure degrades to the last known
    // snapshot (below) rather than flapping the UI into a false "disconnected"
    // state; a persistent failure surfaces via that stale-but-visible state.
    const cloudStatus = await client.getCloudStatus().catch(() => null);
    if (elizaCloudDisconnectInFlightRef.current) {
      return lastElizaCloudPollConnectedRef.current;
    }
    if (!cloudStatus) {
      return lastElizaCloudPollConnectedRef.current;
    }
    const enabled = Boolean(cloudStatus.enabled ?? false);
    const cloudVoiceProxyAvailable = Boolean(
      cloudStatus.cloudVoiceProxyAvailable ?? false,
    );
    const hasPersistedApiKey = Boolean(cloudStatus.hasApiKey);
    // Trust `connected` from the server snapshot (it already folds in API key + CLOUD_AUTH).
    const isConnected = Boolean(cloudStatus.connected);
    if (isConnected && elizaCloudPreferDisconnectedUntilLoginRef.current) {
      publishElizaCloudVoiceSnapshot(setElizaCloudHasPersistedKey, {
        apiConnected: isConnected,
        enabled,
        cloudVoiceProxyAvailable,
        hasPersistedApiKey,
      });
      lastElizaCloudPollConnectedRef.current = false;
      return false;
    }
    if (!isConnected) {
      elizaCloudPreferDisconnectedUntilLoginRef.current = false;
    }
    setElizaCloudEnabled(enabled);
    setElizaCloudVoiceProxyAvailable(cloudVoiceProxyAvailable);
    setElizaCloudConnected(isConnected);
    publishElizaCloudVoiceSnapshot(setElizaCloudHasPersistedKey, {
      apiConnected: isConnected,
      enabled,
      cloudVoiceProxyAvailable,
      hasPersistedApiKey,
    });
    setElizaCloudUserId(cloudStatus.userId ?? null);
    setElizaCloudStatusReason(
      isConnected &&
        typeof cloudStatus.reason === "string" &&
        cloudStatus.reason.trim()
        ? cloudStatus.reason.trim()
        : null,
    );
    if (cloudStatus.topUpUrl) setElizaCloudTopUpUrl(cloudStatus.topUpUrl);
    if (isConnected) {
      // error-policy:J4 a transport failure fetching credits degrades to null
      // (no fabricated balance) but is carried into the visible credits-error
      // state below — the balance widget renders a real error, never
      // healthy-empty; the next poll interval retries.
      let creditsFetchError: string | null = null;
      const credits = await client.getCloudCredits().catch((err: unknown) => {
        creditsFetchError = err instanceof Error ? err.message : String(err);
        logger.warn({ err }, "[useCloudState] cloud credits fetch failed");
        return null;
      });
      if (elizaCloudDisconnectInFlightRef.current) {
        return lastElizaCloudPollConnectedRef.current;
      }
      if (credits?.authRejected) {
        setElizaCloudAuthRejected(true);
        setElizaCloudCreditsError(null);
        setElizaCloudCredits(null);
        setElizaCloudCreditsLow(false);
        setElizaCloudCreditsCritical(false);
        if (credits.topUpUrl) setElizaCloudTopUpUrl(credits.topUpUrl);
      } else {
        setElizaCloudAuthRejected(false);
        const apiErr =
          credits &&
          typeof credits.error === "string" &&
          credits.error.trim() &&
          typeof credits.balance !== "number"
            ? credits.error.trim()
            : creditsFetchError;
        setElizaCloudCreditsError(apiErr);
        if (credits && typeof credits.balance === "number") {
          setElizaCloudCredits(credits.balance);
          setElizaCloudCreditsLow(credits.low ?? false);
          setElizaCloudCreditsCritical(credits.critical ?? false);
          if (credits.topUpUrl) setElizaCloudTopUpUrl(credits.topUpUrl);
        } else {
          setElizaCloudCredits(null);
          setElizaCloudCreditsLow(false);
          setElizaCloudCreditsCritical(false);
          if (credits?.topUpUrl) setElizaCloudTopUpUrl(credits.topUpUrl);
        }
      }
    } else {
      setElizaCloudCredits(null);
      setElizaCloudCreditsLow(false);
      setElizaCloudCreditsCritical(false);
      setElizaCloudAuthRejected(false);
      setElizaCloudCreditsError(null);
      setElizaCloudStatusReason(null);
    }
    lastElizaCloudPollConnectedRef.current = isConnected;
    // Self-manage the recurring poll interval: start when connected, stop when not.
    // This covers login during first-run setup (interval wasn't started at mount) and
    // disconnect (interval should stop to avoid useless API calls).
    if (isConnected && !elizaCloudPollInterval.current) {
      elizaCloudPollInterval.current = window.setInterval(() => {
        if (
          typeof document !== "undefined" &&
          document.visibilityState !== "visible"
        ) {
          return;
        }
        void pollCloudCredits();
      }, 60_000);
    } else if (!isConnected && elizaCloudPollInterval.current) {
      clearInterval(elizaCloudPollInterval.current);
      elizaCloudPollInterval.current = null;
    }
    return isConnected;
  }, []);

  const handleCloudLogin = useCallback(
    async (prePoppedWindow: Window | null = null) => {
      let prePoppedWindowNavigatedExternally = false;
      const closePrePoppedWindow = () => {
        if (!prePoppedWindow || prePoppedWindowNavigatedExternally) return;
        try {
          prePoppedWindow.close();
        } catch {
          // error-policy:J6 best-effort teardown — closing a window the user
          // navigated cross-origin throws; nothing to recover.
        }
      };

      if (
        isCloudStatusAuthenticated(elizaCloudConnected, elizaCloudStatusReason)
      ) {
        closePrePoppedWindow();
        return;
      }
      if (elizaCloudLoginBusyRef.current || elizaCloudLoginBusy) {
        closePrePoppedWindow();
        await elizaCloudLoginCompletionRef.current;
        return;
      }
      elizaCloudLoginBusyRef.current = true;
      setElizaCloudLoginBusy(true);
      setElizaCloudLoginError(null);
      setElizaCloudLoginFallbackUrl(null);
      elizaCloudPreferDisconnectedUntilLoginRef.current = false;
      let resolveLoginCompletion: () => void = () => {};
      let loginCompletionResolved = false;
      const loginCompletion = new Promise<void>((resolve) => {
        resolveLoginCompletion = resolve;
      });
      const completeLogin = () => {
        if (loginCompletionResolved) return;
        loginCompletionResolved = true;
        if (elizaCloudLoginCompletionRef.current === loginCompletion) {
          elizaCloudLoginCompletionRef.current = null;
        }
        resolveLoginCompletion();
      };
      elizaCloudLoginCompletionRef.current = loginCompletion;

      // Zero-interaction wallet SIWE (#13377) is the E2E HARNESS path ONLY.
      // A real browser wallet (Phantom, MetaMask, …) injects window.ethereum
      // too, so taking this branch for any injected provider auto-pops the
      // user's wallet the instant they click "Sign in with Eliza Cloud" —
      // even when they meant to pick Google — and leaves the pre-opened
      // popup blank (the "white page"). Real wallet sign-in is an EXPLICIT
      // choice behind the /login page's EVM/Solana buttons; only the harness
      // wallet (isElizaE2eWallet, packages/ui/src/platform/e2e-wallet.ts, which
      // by its own gates never installs on deployed web) may sign in headlessly.
      if (
        !hasUsableStoredStewardToken() &&
        getInjectedEthereumProvider()?.isElizaE2eWallet === true
      ) {
        const siweBase =
          getBootConfig().cloudApiBase ?? "https://elizacloud.ai";
        try {
          const apiKey = await siweLoginWithInjectedWallet(siweBase);
          if (apiKey) {
            closePrePoppedWindow();
            const connected = await pollCloudCredits();
            // error-policy:J4 wallet config is a secondary panel; a failed
            // load must not undo a verified login.
            await loadWalletConfig().catch(() => undefined);
            if (connected) {
              setElizaCloudConnected(true);
              setElizaCloudLoginError(null);
              setActionNotice(
                "Logged in to Eliza Cloud successfully.",
                "success",
                6000,
              );
            } else {
              setElizaCloudLoginError(
                "Could not verify your Eliza Cloud session. Please sign in again.",
              );
            }
            elizaCloudLoginBusyRef.current = false;
            setElizaCloudLoginBusy(false);
            completeLogin();
            return loginCompletion;
          }
        } catch (err) {
          // error-policy:J4 a declined/failed wallet handshake is a designed
          // degrade — the Steward / device-code paths below remain this
          // click's way in; the failure is logged for the harness.
          logger.warn(
            { err },
            "[useCloudState] SIWE wallet login failed; falling through",
          );
        }
      }

      // Cloud = Steward everywhere (DECISIONS.md D3). When the shell-router has
      // mounted the Steward provider it registers a launcher; drive the in-app
      // Steward sign-in (passkey / email / OAuth / wallet) instead of the
      // legacy device-code browser window. Same identity on web (same-origin
      // cookie + localStorage JWT) and native (Bearer-from-localStorage).
      //
      // Only take this branch when it can complete on THIS click: a still-usable
      // stored token (launchStewardLogin short-circuits on it) or a mounted
      // launcher. A stored-but-EXPIRED JWT with no launcher mounted used to
      // enter the branch anyway; launchStewardLogin drained the stale token and
      // then threw "the Steward login surface is not mounted", so the first
      // click dead-ended on an error and only the second click (token now gone)
      // reached the working device-code flow. Instead, drain the stale token
      // below and fall through to the device-code flow on the same click.
      if (hasUsableStoredStewardToken() || hasStewardLoginLauncher()) {
        closePrePoppedWindow();
        try {
          await launchStewardLogin();
          // Gate the connected state + success toast on an ACTUAL authed status
          // call. `launchStewardLogin` short-circuits on a stored token; if that
          // token is stale/revoked the status poll reports disconnected, so
          // declaring "connected" + toasting here would be a false success that
          // 401s the agent picker in a loop. Only celebrate a verified session;
          // otherwise surface the re-auth path the login UI already renders.
          const connected = await pollCloudCredits();
          // error-policy:J4 wallet config is a secondary panel; a failed load
          // must not undo a verified login. The wallet section renders its own
          // unavailable state from the empty config.
          await loadWalletConfig().catch(() => undefined);
          if (connected) {
            setElizaCloudConnected(true);
            setElizaCloudLoginError(null);
            setActionNotice(
              "Logged in to Eliza Cloud successfully.",
              "success",
              6000,
            );
          } else {
            setElizaCloudLoginError(
              "Could not verify your Eliza Cloud session. Please sign in again.",
            );
          }
        } catch (err) {
          setElizaCloudLoginError(
            err instanceof Error ? err.message : "Eliza Cloud login failed",
          );
        } finally {
          elizaCloudLoginBusyRef.current = false;
          setElizaCloudLoginBusy(false);
          completeLogin();
        }
        return loginCompletion;
      }

      // A stored-but-stale Steward JWT with no launcher mounted: drain it so it
      // cannot shadow the device-code credentials in subsequent authed calls
      // (this mirrors what launchStewardLogin would have done before throwing).
      if (readStoredStewardToken()?.trim()) {
        clearStoredStewardToken();
      }

      // Legacy device-code fallback (retired for Cloud; preserved for the
      // Remote / self-hosted pairing handshake and for desktop/CLI builds where
      // the Steward surface is not yet mounted). Determine if we should use
      // direct cloud auth (no local backend) or go through the agent proxy.
      const hasBackend = hasCloudLoginBackend();
      const cloudApiBase =
        getBootConfig().cloudApiBase ?? "https://elizacloud.ai";
      let useDirectAuth = !hasBackend;

      if (hasBackend) {
        // error-policy:J4 a null status here is a designed branch: a
        // browser/dev shell with no local agent proxy falls back to the direct
        // Cloud auth flow (below), not an error state.
        const cloudStatus = await client.getCloudStatus().catch(() => null);
        if (cloudStatus === null) {
          // Browser/dev shells can run on localhost without a local agent proxy.
          // In that case, keep first-run Cloud usable via the direct Cloud flow.
          useDirectAuth = true;
        }
        const alreadyAuthenticated = isCloudStatusAuthenticated(
          Boolean(cloudStatus?.connected),
          cloudStatus?.reason,
        );
        if (alreadyAuthenticated) {
          closePrePoppedWindow();
          await pollCloudCredits();
          await loadWalletConfig().catch((err: unknown) => {
            // error-policy:J4 already-authenticated login has succeeded; a
            // wallet config refresh failure must not wedge the login button.
            logger.warn(
              { err },
              "[useCloudState] wallet config refresh failed after cloud login",
            );
          });
          setElizaCloudLoginError(null);
          setActionNotice("Already connected to Eliza Cloud.", "info", 4000);
          elizaCloudLoginBusyRef.current = false;
          setElizaCloudLoginBusy(false);
          completeLogin();
          return loginCompletion;
        }
      }

      // #15143 mobile-web sign-in: when the popup path cannot work — the
      // pre-opened handle came back null (popup blocked; the runtime signal on
      // any browser) or this is a touch-primary browser where even a popup
      // that opens is a disorienting tab switch — navigate THIS tab to the
      // same-origin Steward /login page instead of starting a device-code
      // session whose browser window would never open. The returnTo round
      // trip lands back here and the stored Steward token completes the login
      // (first-run resumes via its marker + mount-time token poll). Direct
      // cloud targets only: an agent-proxied (hasBackend) login stays on the
      // device-code flow, whose copyable fallback link is the designed
      // degrade for blocked popups there.
      if (useDirectAuth && shouldUseSameTabCloudLogin(prePoppedWindow)) {
        closePrePoppedWindow();
        navigateToSameTabCloudLogin();
        elizaCloudLoginBusyRef.current = false;
        setElizaCloudLoginBusy(false);
        completeLogin();
        return loginCompletion;
      }

      try {
        let resp: {
          ok: boolean;
          apiBase?: string;
          browserUrl?: string;
          sessionId?: string;
          error?: string;
        };
        if (useDirectAuth) {
          resp = await client.cloudLoginDirect(cloudApiBase);
        } else {
          resp = await client.cloudLogin();
        }
        if (!resp.ok) {
          closePrePoppedWindow();
          setElizaCloudLoginError(
            resp.error || "Failed to start Eliza Cloud login",
          );
          elizaCloudLoginBusyRef.current = false;
          setElizaCloudLoginBusy(false);
          completeLogin();
          return loginCompletion;
        }

        // Open the login URL in the system browser. On Capacitor iOS the
        // pre-opened window preserves the user-gesture context so WKWebView
        // routes the URL out to Safari instead of dropping it silently.
        //
        // Regardless of whether the auto-open succeeds, expose the URL via
        // `elizaCloudLoginFallbackUrl` so the renderer can render a
        // copyable "didn't open? visit this link" panel. Some desktop
        // handlers (e.g. Tails' Tor Browser flatpak when Tor has not
        // bootstrapped, or any environment where xdg-open silently fails)
        // open without crashing but never surface a usable window.
        if (resp.browserUrl) {
          setElizaCloudLoginFallbackUrl(resp.browserUrl);
          if (prePoppedWindow) {
            navigatePreOpenedWindow(prePoppedWindow, resp.browserUrl);
            prePoppedWindowNavigatedExternally = true;
          } else {
            try {
              await openExternalUrl(resp.browserUrl);
            } catch {
              // error-policy:J4 browser launch failed — degrade to a visible
              // copyable link so the user can complete login manually.
              setElizaCloudLoginError(
                `Open this link to log in: ${resp.browserUrl}`,
              );
            }
          }
        } else {
          closePrePoppedWindow();
        }

        const sessionId = resp.sessionId ?? "";
        const authenticatedCloudApiBase =
          useDirectAuth && resp.apiBase ? resp.apiBase : cloudApiBase;

        let pollInFlight = false;
        let consecutivePollErrors = 0;
        const pollDeadline = Date.now() + ELIZA_CLOUD_LOGIN_TIMEOUT_MS;
        const stopCloudLoginPolling = (error: string | null = null) => {
          if (elizaCloudLoginPollTimer.current !== null) {
            clearInterval(elizaCloudLoginPollTimer.current);
            elizaCloudLoginPollTimer.current = null;
          }
          elizaCloudLoginBusyRef.current = false;
          setElizaCloudLoginBusy(false);
          // Clear the manual-link fallback once the device-code session is
          // no longer active — the URL is single-use and showing a stale
          // link after timeout / cancellation is misleading.
          setElizaCloudLoginFallbackUrl(null);
          if (error !== null) {
            setElizaCloudLoginError(error);
          }
          completeLogin();
        };

        // Start polling
        elizaCloudLoginPollTimer.current = window.setInterval(async () => {
          if (!elizaCloudLoginPollTimer.current || pollInFlight) return;
          if (Date.now() >= pollDeadline) {
            stopCloudLoginPolling(
              "Eliza Cloud login timed out. Please try again.",
            );
            return;
          }

          pollInFlight = true;
          try {
            if (!elizaCloudLoginPollTimer.current) return;
            let poll: {
              status: string;
              organizationId?: string;
              token?: string;
              userId?: string;
              error?: string;
            };
            if (useDirectAuth) {
              poll = await client.cloudLoginPollDirect(
                authenticatedCloudApiBase,
                sessionId,
              );
            } else {
              poll = await client.cloudLoginPoll(sessionId);
            }
            if (!elizaCloudLoginPollTimer.current) return;

            consecutivePollErrors = 0;
            if (poll.status === "authenticated") {
              if (poll.token && typeof window !== "undefined") {
                // Persist the device-code session token through the canonical
                // steward-session store (which getCloudAuthToken reads first). On
                // a native device the OAuth opens an external browser
                // (SFSafariViewController) which backgrounds the WebView; iOS
                // often cold-launches it on return, so the token must be durable,
                // not a volatile in-memory global — otherwise getCloudAuthToken()
                // reads nothing, elizaCloudConnected never recomputes true, and
                // onboarding restarts at the greeting.
                writeStoredStewardToken(poll.token);
                // Also update boot config so subsequent reads use the resolved cloud base.
                const cfg = getBootConfig();
                setBootConfig({
                  ...cfg,
                  cloudApiBase: authenticatedCloudApiBase,
                });
              }

              if (useDirectAuth) {
                if (!poll.token) {
                  stopCloudLoginPolling(
                    "Eliza Cloud login completed, but the cloud session did not return an API key.",
                  );
                  return;
                }
                client.setBaseUrl(authenticatedCloudApiBase, {
                  persist: false,
                });
                client.setToken(poll.token);
              }

              closePrePoppedWindow();
              void closeExternalBrowser();

              stopCloudLoginPolling();
              setElizaCloudConnected(true);
              setElizaCloudLoginError(null);
              if (poll.userId) {
                setElizaCloudUserId(poll.userId);
              }

              setActionNotice(
                "Logged in to Eliza Cloud successfully.",
                "success",
                6000,
              );

              // The backend owns the cloud-wallet bind + runtime reload now.
              // Startup/ws recovery will rehydrate wallet + cloud state once the
              // restart completes, so avoid kicking off a second client restart.
            } else if (poll.status === "expired" || poll.status === "error") {
              stopCloudLoginPolling(
                poll.error ?? "Login session expired. Please try again.",
              );
            }
          } catch (pollErr) {
            if (!elizaCloudLoginPollTimer.current) return;

            consecutivePollErrors += 1;
            if (
              consecutivePollErrors >= ELIZA_CLOUD_LOGIN_MAX_CONSECUTIVE_ERRORS
            ) {
              const detail =
                pollErr instanceof Error && pollErr.message
                  ? ` Last error: ${pollErr.message}`
                  : "";
              stopCloudLoginPolling(
                `Eliza Cloud login check failed after repeated errors.${detail}`,
              );
            }
          } finally {
            pollInFlight = false;
          }
        }, ELIZA_CLOUD_LOGIN_POLL_INTERVAL_MS);
      } catch (err) {
        setElizaCloudLoginError(
          err instanceof Error ? err.message : "Eliza Cloud login failed",
        );
        // Drop the manual-link fallback on the outer failure path so we
        // don't show a stale verification URL after the session has been
        // abandoned.
        setElizaCloudLoginFallbackUrl(null);
        elizaCloudLoginBusyRef.current = false;
        setElizaCloudLoginBusy(false);
        completeLogin();
      }
      return loginCompletion;
    },
    [
      elizaCloudConnected,
      elizaCloudLoginBusy,
      elizaCloudStatusReason,
      setActionNotice,
      pollCloudCredits,
      loadWalletConfig,
    ],
  );

  const handleCloudDisconnect = useCallback(
    async (opts?: { skipConfirmation?: boolean }): Promise<void> => {
      const MAIN_CONFIRM_DISCONNECT_MS = 300_000;
      const MAIN_POST_ONLY_MS = 12_000;
      const RENDERER_DISCONNECT_MS = 12_000;
      const skipConfirmation = opts?.skipConfirmation === true;

      if (disconnectLocked || isElizaCloudRuntimeLocked()) {
        setActionNotice(
          "Eliza Cloud is required while this app is running in cloud mode.",
          "error",
        );
        return;
      }

      elizaCloudDisconnectInFlightRef.current = true;
      setElizaCloudDisconnecting(true);

      try {
        const wasConnected = elizaCloudConnected;
        let needRendererDisconnect = true;

        if (isElectrobunRuntime()) {
          if (!skipConfirmation) {
            const combined = await invokeDesktopBridgeRequestWithTimeout<
              { cancelled: true } | { ok: true } | { ok: false; error?: string }
            >({
              rpcMethod: "agentCloudDisconnectWithConfirm",
              ipcChannel: "agent:cloudDisconnectWithConfirm",
              params: {
                apiBase: client.getBaseUrl().trim() || undefined,
                bearerToken: client.getRestAuthToken() ?? undefined,
              },
              timeoutMs: MAIN_CONFIRM_DISCONNECT_MS,
            });

            if (combined.status === "ok" && combined.value) {
              const v = combined.value;
              if ("cancelled" in v && v.cancelled) {
                return;
              }
              if ("ok" in v) {
                if (
                  v.ok === false &&
                  typeof v.error === "string" &&
                  v.error.trim()
                ) {
                  throw new Error(v.error.trim());
                }
                if (v.ok === true) {
                  needRendererDisconnect = false;
                }
              }
            }
          }

          if (needRendererDisconnect) {
            if (
              !skipConfirmation &&
              !(await confirmDesktopAction({
                title: "Disconnect from Eliza Cloud",
                message:
                  "The agent will need a local AI provider to continue working.",
                confirmLabel: "Disconnect",
                cancelLabel: "Cancel",
                type: "warning",
              }))
            ) {
              return;
            }
            if (!skipConfirmation) {
              await yieldHttpAfterNativeMessageBox();
            }

            const postOutcome = await invokeDesktopBridgeRequestWithTimeout<{
              ok: boolean;
              error?: string;
            }>({
              rpcMethod: "agentPostCloudDisconnect",
              ipcChannel: "agent:postCloudDisconnect",
              params: {
                apiBase: client.getBaseUrl().trim() || undefined,
                bearerToken: client.getRestAuthToken() ?? undefined,
              },
              timeoutMs: MAIN_POST_ONLY_MS,
            });

            if (postOutcome.status === "ok" && postOutcome.value) {
              const mr = postOutcome.value;
              if (mr.ok === true) {
                needRendererDisconnect = false;
              } else if (
                mr.ok === false &&
                typeof mr.error === "string" &&
                mr.error.trim()
              ) {
                throw new Error(mr.error.trim());
              }
            }
          }
        } else if (!skipConfirmation) {
          if (
            !(await confirmDesktopAction({
              title: "Disconnect from Eliza Cloud",
              message:
                "The agent will need a local AI provider to continue working.",
              confirmLabel: "Disconnect",
              cancelLabel: "Cancel",
              type: "warning",
            }))
          ) {
            return;
          }
          await yieldHttpAfterNativeMessageBox();
        }

        if (needRendererDisconnect) {
          await Promise.race([
            client.cloudDisconnect(),
            new Promise<never>((_, reject) => {
              window.setTimeout(() => {
                reject(
                  new Error(
                    `Disconnect timed out after ${RENDERER_DISCONNECT_MS / 1000}s`,
                  ),
                );
              }, RENDERER_DISCONNECT_MS);
            }),
          ]);
        }

        setElizaCloudEnabled(false);
        setElizaCloudConnected(false);
        publishElizaCloudVoiceSnapshot(setElizaCloudHasPersistedKey, {
          apiConnected: false,
          enabled: false,
          cloudVoiceProxyAvailable: false,
          hasPersistedApiKey: false,
        });
        setElizaCloudVoiceProxyAvailable(false);
        setElizaCloudCredits(null);
        setElizaCloudCreditsLow(false);
        setElizaCloudCreditsCritical(false);
        setElizaCloudAuthRejected(false);
        setElizaCloudCreditsError(null);
        setElizaCloudUserId(null);
        setElizaCloudStatusReason(null);
        lastElizaCloudPollConnectedRef.current = false;
        elizaCloudPreferDisconnectedUntilLoginRef.current = true;
        // Drop the persisted JWT on disconnect. The full sign-out path
        // (StewardProviderRuntime) already scrubs it; cloud-disconnect cleared
        // in-memory state but left active-server.accessToken in localStorage —
        // an at-rest JWT leak readable by XSS / plugin views. Keep the server
        // selection (kind/apiBase/label) so we know where to re-authenticate.
        scrubPersistedActiveServerToken();
        // SECURITY: scrubbing active-server.accessToken alone is incomplete —
        // the LIVE cloud bearer also lives in (a) localStorage steward_session_token
        // (the JWT read on every /api/* call, and where the device-code flow
        // persists its session token) and (b) per-agent-profile accessToken
        // copies. Clear both on an explicit disconnect so no usable credential
        // survives at rest / in memory (XSS / same-origin plugin views).
        clearStoredStewardToken();
        scrubPersistedAgentProfileTokens();
        if (wasConnected) {
          setActionNotice("Disconnected from Eliza Cloud.", "success");
        }
      } catch (err) {
        setActionNotice(
          `Failed to disconnect: ${err instanceof Error ? err.message : err}`,
          "error",
        );
      } finally {
        elizaCloudDisconnectInFlightRef.current = false;
        setElizaCloudDisconnecting(false);
        void pollCloudCredits();
      }
    },
    [disconnectLocked, elizaCloudConnected, pollCloudCredits, setActionNotice],
  );

  const handleCloudSignOut = useCallback(async (): Promise<void> => {
    // On a backend-backed session (local app-core / agent runtime) the Cloud
    // account is also persisted server-side and re-reported by
    // /api/cloud/status. Clearing only the renderer/Steward token there leaves
    // the backend connected, so a reload or fresh poll would resurface the same
    // account. Delegate to the real disconnect path (which clears the server
    // session) unless the runtime is locked. The account-only clear below is
    // reserved for the locked mobile runtime, where handleCloudDisconnect
    // refuses (Cloud is required in cloud mode) and only the account session
    // can be dropped.
    if (!(disconnectLocked || isElizaCloudRuntimeLocked())) {
      await handleCloudDisconnect({ skipConfirmation: true });
      return;
    }

    elizaCloudDisconnectInFlightRef.current = true;
    setElizaCloudDisconnecting(true);

    try {
      clearStaleStewardSession();
      setElizaCloudEnabled(false);
      setElizaCloudConnected(false);
      publishElizaCloudVoiceSnapshot(setElizaCloudHasPersistedKey, {
        apiConnected: false,
        enabled: false,
        cloudVoiceProxyAvailable: false,
        hasPersistedApiKey: false,
      });
      setElizaCloudVoiceProxyAvailable(false);
      setElizaCloudCredits(null);
      setElizaCloudCreditsLow(false);
      setElizaCloudCreditsCritical(false);
      setElizaCloudAuthRejected(false);
      setElizaCloudCreditsError(null);
      setElizaCloudUserId(null);
      setElizaCloudStatusReason(null);
      setElizaCloudLoginError(null);
      setElizaCloudLoginFallbackUrl(null);
      lastElizaCloudPollConnectedRef.current = false;
      elizaCloudPreferDisconnectedUntilLoginRef.current = true;
      setActionNotice("Signed out of Eliza Cloud.", "success", 5000);
    } finally {
      elizaCloudDisconnectInFlightRef.current = false;
      setElizaCloudDisconnecting(false);
      void pollCloudCredits();
    }
  }, [
    disconnectLocked,
    handleCloudDisconnect,
    pollCloudCredits,
    setActionNotice,
  ]);

  // ── Effects ────────────────────────────────────────────────────────

  useEffect(() => {
    if (elizaCloudAuthRejected) {
      if (!elizaCloudAuthNoticeSentRef.current) {
        elizaCloudAuthNoticeSentRef.current = true;
        setActionNotice(t("notice.elizaCloudAuthRejected"), "error", 14_000);
      }
    } else {
      elizaCloudAuthNoticeSentRef.current = false;
    }
  }, [elizaCloudAuthRejected, setActionNotice, t]);

  // Cloud=Steward token lifecycle (mirrors cloud-frontend's AuthTokenSync).
  // While a Steward session token is present, refresh it ahead of its JWT `exp`
  // so an authenticated cloud connection never silently expires. Web refreshes
  // via the same-origin cookie path; native refreshes against the cloud API
  // base (Bearer-refresh). A 401 / no-token outcome is left for the next
  // pollCloudCredits() to surface as auth-rejected.
  //
  // Armed on stored-token PRESENCE, not on `elizaCloudConnected`: a returning
  // user's stored JWT can already be expired at mount, and `elizaCloudConnected`
  // only flips true after a successful status/credits poll — which can't happen
  // while every call 401s on the dead token. Gating on the connection flag
  // therefore deadlocked expired-token users (nothing ever refreshed the token
  // that blocked the connection). Presence-gating breaks that: the check runs at
  // mount for any stored token and refreshes a near-expiry/expired JWT so the
  // next poll can succeed. A comfortably-valid token still no-ops (see the
  // `secs >= STEWARD_REFRESH_AHEAD_SECS` guard), so this adds no needless work.
  //
  // biome-ignore lint/correctness/useExhaustiveDependencies: elizaCloudConnected is an intentional re-arm trigger, not read inside — a fresh login writes a new token and flips connected, and the effect must re-run to arm the lifecycle refresh on that token. Presence of a stored token (checked at the top) is the real gate.
  useEffect(() => {
    if (!readStoredStewardToken()?.trim()) return;

    let disposed = false;
    const checkAndRefresh = async () => {
      const token = readStoredStewardToken()?.trim();
      if (!token) return;
      const secs = cloudTokenSecsRemaining(token);
      // No `exp` (opaque token / device-code session) → nothing to refresh.
      if (secs === null) return;
      if (secs >= STEWARD_REFRESH_AHEAD_SECS) return;
      // error-policy:J4 pre-emptive token refresh; a failed refresh keeps the
      // still-valid stored token until it actually expires (the next authed
      // call then surfaces the re-auth path). No token rotation on failure.
      const result = await refreshCloudStewardSession({
        endpoint: resolveStewardRefreshEndpoint(),
      }).catch((err: unknown) => {
        logger.warn({ err }, "[useCloudState] steward session refresh failed");
        return null;
      });
      if (disposed) return;
      if (result?.token) {
        writeStoredStewardToken(result.token);
      }
    };

    void checkAndRefresh();
    const interval = window.setInterval(() => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState !== "visible"
      ) {
        return;
      }
      void checkAndRefresh();
    }, STEWARD_REFRESH_CHECK_INTERVAL_MS);

    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [elizaCloudConnected]);

  // ── Return ─────────────────────────────────────────────────────────

  return {
    // State
    elizaCloudEnabled,
    setElizaCloudEnabled,
    elizaCloudVoiceProxyAvailable,
    setElizaCloudVoiceProxyAvailable,
    elizaCloudConnected,
    setElizaCloudConnected,
    elizaCloudHasPersistedKey,
    setElizaCloudHasPersistedKey,
    elizaCloudCredits,
    setElizaCloudCredits,
    elizaCloudCreditsLow,
    setElizaCloudCreditsLow,
    elizaCloudCreditsCritical,
    setElizaCloudCreditsCritical,
    elizaCloudAuthRejected,
    setElizaCloudAuthRejected,
    elizaCloudCreditsError,
    setElizaCloudCreditsError,
    elizaCloudTopUpUrl,
    setElizaCloudTopUpUrl,
    elizaCloudUserId,
    setElizaCloudUserId,
    elizaCloudStatusReason,
    setElizaCloudStatusReason,
    cloudDashboardView,
    setCloudDashboardView,
    elizaCloudLoginBusy,
    setElizaCloudLoginBusy,
    elizaCloudLoginError,
    setElizaCloudLoginError,
    elizaCloudLoginFallbackUrl,
    setElizaCloudLoginFallbackUrl,
    elizaCloudDisconnecting,
    setElizaCloudDisconnecting,
    // Refs (exposed for cleanup in AppContext's startup effect and for forward ref)
    elizaCloudPollInterval,
    elizaCloudDisconnectInFlightRef,
    elizaCloudPreferDisconnectedUntilLoginRef,
    lastElizaCloudPollConnectedRef,
    elizaCloudLoginPollTimer,
    elizaCloudLoginBusyRef,
    // Callbacks
    pollCloudCredits,
    handleCloudLogin,
    handleCloudDisconnect,
    handleCloudSignOut,
  };
}
