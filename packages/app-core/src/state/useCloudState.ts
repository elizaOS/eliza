/**
 * Eliza Cloud state — extracted from AppContext.
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
 *
 * Note: `handleCloudOnboardingFinish` is kept in AppContext (one-liner that calls
 * `submitOnboardingAndComplete`, which is defined later in AppContext's render order).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../api";
import {
  invokeDesktopBridgeRequestWithTimeout,
  isElectrobunRuntime,
} from "../bridge";
import { getBootConfig, setBootConfig } from "../config/boot-config";
import { dispatchElizaCloudStatusUpdated } from "../events";
import {
  closeExternalBrowser,
  confirmDesktopAction,
  isCloudStatusAuthenticated,
  navigatePreOpenedWindow,
  openExternalUrl,
  yieldHttpAfterNativeMessageBox,
} from "../utils";

// ── Constants ──────────────────────────────────────────────────────────────

const ELIZA_CLOUD_LOGIN_POLL_INTERVAL_MS = 1000;
const ELIZA_CLOUD_LOGIN_TIMEOUT_MS = 300_000;
const ELIZA_CLOUD_LOGIN_MAX_CONSECUTIVE_ERRORS = 3;
const DEFAULT_DIRECT_CLOUD_BASE_URL = "https://www.elizacloud.ai";

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

  return (
    hostname === "localhost" ||
    hostname === "::1" ||
    hostname.endsWith(".local") ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  );
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
    return false;
  }
}

function hasCloudLoginBackend(): boolean {
  const explicitBase =
    typeof client.getBaseUrl === "function" ? client.getBaseUrl().trim() : "";
  if (explicitBase) {
    return (
      !isConfiguredCloudSiteBase(explicitBase) &&
      !isCapacitorAssetBase(explicitBase)
    );
  }
  if (isCapacitorNativeRuntime()) return false;
  return isSameOriginLocalHttpBackend();
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
}

// ── Hook ───────────────────────────────────────────────────────────────────

export function useCloudState({
  setActionNotice,
  loadWalletConfig,
  t,
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
  /** Synchronous lock to prevent duplicate login clicks in the same tick. */
  const elizaCloudLoginBusyRef = useRef(false);
  /** Tracks whether the auth-rejected notice has already been sent for the current rejection. */
  const elizaCloudAuthNoticeSentRef = useRef(false);
  /**
   * Forward ref so handleOnboardingNext (defined earlier in AppContext) can call
   * handleCloudLogin (defined later).
   */
  const handleCloudLoginRef = useRef<() => Promise<void>>(async () => {});

  // ── Callbacks ──────────────────────────────────────────────────────

  const pollCloudCredits = useCallback(async (): Promise<boolean> => {
    if (elizaCloudDisconnectInFlightRef.current) {
      return lastElizaCloudPollConnectedRef.current;
    }
    const cloudStatus = await client.getCloudStatus().catch(() => null);
    if (elizaCloudDisconnectInFlightRef.current) {
      return lastElizaCloudPollConnectedRef.current;
    }
    if (!cloudStatus) {
      // Preserve the last applied cloud snapshot across transient backend
      // restarts so the UI does not flap into a false "disconnected" state.
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
      const credits = await client.getCloudCredits().catch(() => null);
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
            : null;
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
    // This covers login during onboarding (interval wasn't started at mount) and
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
      if (
        isCloudStatusAuthenticated(elizaCloudConnected, elizaCloudStatusReason)
      ) {
        try {
          prePoppedWindow?.close();
        } catch {
          // Cross-origin — ignore.
        }
        return;
      }
      if (elizaCloudLoginBusyRef.current || elizaCloudLoginBusy) {
        try {
          prePoppedWindow?.close();
        } catch {
          // Cross-origin — ignore.
        }
        return;
      }
      elizaCloudLoginBusyRef.current = true;
      setElizaCloudLoginBusy(true);
      setElizaCloudLoginError(null);
      elizaCloudPreferDisconnectedUntilLoginRef.current = false;

      // Determine if we should use direct cloud auth (no local backend) or
      // go through the local agent's proxy.
      const hasBackend = hasCloudLoginBackend();
      const cloudApiBase =
        getBootConfig().cloudApiBase ?? "https://www.elizacloud.ai";
      const useDirectAuth = !hasBackend;

      if (hasBackend) {
        const cloudStatus = await client.getCloudStatus().catch(() => null);
        const alreadyAuthenticated = isCloudStatusAuthenticated(
          Boolean(cloudStatus?.connected),
          cloudStatus?.reason,
        );
        if (alreadyAuthenticated) {
          try {
            prePoppedWindow?.close();
          } catch {
            // Cross-origin — ignore.
          }
          await pollCloudCredits();
          await loadWalletConfig().catch(() => undefined);
          setElizaCloudLoginError(null);
          setActionNotice("Already connected to Eliza Cloud.", "info", 4000);
          elizaCloudLoginBusyRef.current = false;
          setElizaCloudLoginBusy(false);
          return;
        }
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
          try {
            prePoppedWindow?.close();
          } catch {
            // Cross-origin — ignore.
          }
          setElizaCloudLoginError(
            resp.error || "Failed to start Eliza Cloud login",
          );
          elizaCloudLoginBusyRef.current = false;
          setElizaCloudLoginBusy(false);
          return;
        }

        // Open the login URL in the system browser. On Capacitor iOS the
        // pre-opened window preserves the user-gesture context so WKWebView
        // routes the URL out to Safari instead of dropping it silently.
        if (resp.browserUrl) {
          if (prePoppedWindow) {
            navigatePreOpenedWindow(prePoppedWindow, resp.browserUrl);
          } else {
            try {
              await openExternalUrl(resp.browserUrl);
            } catch {
              setElizaCloudLoginError(
                `Open this link to log in: ${resp.browserUrl}`,
              );
            }
          }
        } else {
          try {
            prePoppedWindow?.close();
          } catch {
            // Cross-origin — ignore.
          }
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
          if (error !== null) {
            setElizaCloudLoginError(error);
          }
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
                (
                  globalThis as Record<string, unknown>
                ).__ELIZA_CLOUD_AUTH_TOKEN__ = poll.token;
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

              try {
                prePoppedWindow?.close();
              } catch {
                // Cross-origin — ignore.
              }
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
            console.error("Eliza Cloud login poll error:", pollErr);
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
        elizaCloudLoginBusyRef.current = false;
        setElizaCloudLoginBusy(false);
      }
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

  // Keep forward ref in sync so handleOnboardingNext can call it.
  handleCloudLoginRef.current = handleCloudLogin;

  const handleCloudDisconnect = useCallback(
    async (opts?: { skipConfirmation?: boolean }): Promise<void> => {
      const MAIN_CONFIRM_DISCONNECT_MS = 300_000;
      const MAIN_POST_ONLY_MS = 12_000;
      const RENDERER_DISCONNECT_MS = 12_000;
      const skipConfirmation = opts?.skipConfirmation === true;

      elizaCloudDisconnectInFlightRef.current = true;
      setElizaCloudDisconnecting(true);

      try {
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
        setActionNotice("Disconnected from Eliza Cloud.", "success");
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
    [pollCloudCredits, setActionNotice],
  );

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
    elizaCloudDisconnecting,
    setElizaCloudDisconnecting,
    // Refs (exposed for cleanup in AppContext's startup effect and for forward ref)
    elizaCloudPollInterval,
    elizaCloudDisconnectInFlightRef,
    elizaCloudPreferDisconnectedUntilLoginRef,
    lastElizaCloudPollConnectedRef,
    elizaCloudLoginPollTimer,
    elizaCloudLoginBusyRef,
    handleCloudLoginRef,
    // Callbacks
    pollCloudCredits,
    handleCloudLogin,
    handleCloudDisconnect,
  };
}
