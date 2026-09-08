/**
 * useAgentSessionRecovery, bridges the unauthenticated auth state (#15132) to
 * a transparent re-pair instead of the password-wall dead-end.
 *
 * When `/api/auth/me` 401s AFTER a dedicated cloud agent's container upgrade,
 * the browser's persisted agent credential is stale but the cloud session is
 * still valid. This hook detects that exact case and re-runs the cloud pairing
 * exchange (the same flow first-pairing uses). Browser clients navigate through
 * `/pair`; native clients exchange and install the credential in-process, then
 * re-probe auth. Non-recoverable managed-native outcomes become explicit
 * reauth, retry, or Cloud-management states; self-hosted access remains idle so
 * the owner-password form can render.
 *
 * SECURITY (auth-adjacent): this NEVER bypasses the wall. Recovery only fires
 * when a valid cloud session exists to re-pair from; the server still gates the
 * pairing-token mint. Managed-native failures preserve the Cloud credential
 * unless Cloud actually rejected it; only self-hosted targets return to the
 * owner-password wall.
 */

import { logger } from "@elizaos/logger";
import {
  getStewardTabSessionAuthorityCoordinator,
  StewardSessionAuthorityError,
  type StewardSessionAuthoritySnapshot,
} from "@elizaos/shared/steward-session-client";
import { useEffect, useRef, useState } from "react";
import { client } from "../api";
import { getCloudAuthToken } from "../api/client-cloud";
import { isAppModeHost } from "../cloud/app-mode/app-mode";
import { persistCloudPairApiToken } from "../components/auth/CloudPairRelay";
import { getBootConfig } from "../config/boot-config";
import { persistActiveServerCredential } from "../state/active-server-credential";
import {
  type AgentSessionUnauthReason,
  agentSessionRepairNeedsCloudToken,
  isManagedCloudAgentServer,
  type ManagedCloudAgentRecoveryStatus,
  resolveAgentSessionRecovery,
  resolveDedicatedAgentId,
} from "../state/agent-session-recovery";
import { runAgentSessionRecovery } from "../state/agent-session-recovery-runner";
import { clearStalePairCredentialsForAgent } from "../state/cloud-pair-token";
import { ensureCloudSessionForRepair } from "../state/cloud-session-refresh-for-repair";
import {
  loadPersistedActiveServer,
  type PersistedActiveServer,
} from "../state/persistence";
import { useIsAuthenticated } from "./useAuthStatus";

export type AgentSessionRecoveryStatus =
  /** Not a recoverable state, the auth gate should render the wall. */
  | "idle"
  /** A re-pair is in flight, the auth gate should hold (no wall yet). */
  | "recovering"
  /** Cloud rejected or lacks the credential needed for native recovery. */
  | "cloud-reauth-required"
  /** Native recovery failed without proving the Cloud credential invalid. */
  | "cloud-retry-required"
  /** The managed agent needs attention in Cloud; reauth/retry cannot fix it. */
  | "cloud-manage-required";

interface UseAgentSessionRecoveryOptions {
  /**
   * Whether the app is currently in the unauthenticated state, and (when so)
   * the `/api/auth/me` reason. `active: false` disables the hook entirely.
   */
  active: boolean;
  reason: AgentSessionUnauthReason;
  /** Injected navigate (tests). Defaults to a full-page window assignment. */
  navigate?: (url: string) => void;
  /** Re-probe agent auth immediately after an in-process native exchange. */
  onRecovered?: () => void;
}

function defaultNavigate(url: string): void {
  if (typeof window !== "undefined") {
    window.location.assign(url);
  }
}

/**
 * Whether recovery redeems the one-time pairing token in-process instead of
 * full-page navigating into the per-agent `/pair` relay.
 *
 * Native has always consumed in-process (it has no browser navigation). The
 * Eliza app hosts must too: `../cloud/app-mode/app-mode.ts` established the
 * chat floor because a cold-starting agent cannot consume a 60s one-time token
 * inside its TTL, so the redirect dead-ends on "Sign-in link expired" and the
 * user is bounced back through a second full sign-in. Entry stopped
 * pairing-redirecting there (#18016); recovery is the remaining caller that
 * did, which reopened the same dead-end on app-staging. The exchange endpoint
 * (`/api/auth/pair/native`) authenticates with the Cloud session the browser
 * already holds, so the app hosts can redeem it directly and stay same-origin.
 */
function isNativeRuntime(): boolean {
  try {
    const cap = (globalThis as Record<string, unknown>).Capacitor as
      | { isNativePlatform?: () => boolean }
      | undefined;
    return Boolean(cap?.isNativePlatform?.());
  } catch {
    // error-policy:J4 an unavailable native bridge means browser-style
    // navigation remains the compatible fallback.
    return false;
  }
}

function shouldConsumePairRedirectInProcess(): boolean {
  return isNativeRuntime() || isAppModeHost();
}

function normalizedOptionalValue(value: string | undefined): string {
  return value?.trim() ?? "";
}

function normalizedOptionalBase(value: string | undefined): string {
  return normalizedOptionalValue(value).replace(/\/+$/, "");
}

/** A late recovery may commit only to the exact server record that started it. */
function recoveryTargetMatches(
  expected: PersistedActiveServer,
  current: PersistedActiveServer | null,
): boolean {
  return Boolean(
    current &&
      current.kind === expected.kind &&
      current.id === expected.id &&
      normalizedOptionalBase(current.apiBase) ===
        normalizedOptionalBase(expected.apiBase) &&
      normalizedOptionalValue(current.accessToken) ===
        normalizedOptionalValue(expected.accessToken),
  );
}

export function useAgentSessionRecovery(
  options: UseAgentSessionRecoveryOptions,
): AgentSessionRecoveryStatus {
  const { active, reason, navigate = defaultNavigate, onRecovered } = options;
  const [status, setStatus] = useState<AgentSessionRecoveryStatus>("idle");
  const isAuthenticated = useIsAuthenticated();
  // A loading refetch briefly leaves the unauthenticated state, so only a
  // confirmed session (or remount) may rearm recovery for a later genuine 401.
  const attemptedRef = useRef(false);
  const awaitingCloudTokenRef = useRef(false);
  const attemptedFallbackRef = useRef<ManagedCloudAgentRecoveryStatus>(
    "cloud-retry-required",
  );
  const [cloudTokenSnapshot, setCloudTokenSnapshot] = useState(() =>
    getCloudAuthToken(),
  );
  const observedCloudTokenRef = useRef(cloudTokenSnapshot);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const rearmAfterCloudReauth = () => {
      const cloudToken = getCloudAuthToken();
      const changed = cloudToken !== observedCloudTokenRef.current;
      observedCloudTokenRef.current = cloudToken;
      if (cloudToken?.trim() && (changed || awaitingCloudTokenRef.current)) {
        // A separate sign-in can finish before cookie recovery reaches its
        // fallback. Retire that attempt and let the new effect capture fresh
        // authority; never adopt the token into the obsolete flight.
        awaitingCloudTokenRef.current = false;
        attemptedRef.current = false;
      }
      if (changed) setCloudTokenSnapshot(cloudToken);
    };

    window.addEventListener("steward-token-sync", rearmAfterCloudReauth);
    return () => {
      window.removeEventListener("steward-token-sync", rearmAfterCloudReauth);
    };
  }, []);

  useEffect(() => {
    const consumeRedirectInProcess = shouldConsumePairRedirectInProcess();
    const activeServer = active ? loadPersistedActiveServer() : null;
    // Deliberately keyed to the native runtime, not to in-process redemption:
    // the app hosts now redeem in-process too, and this flag drives the
    // native-only managed-recovery status UI.
    const isManagedNative =
      isNativeRuntime() && isManagedCloudAgentServer(activeServer);
    const fallbackStatus = (
      managedStatus: ManagedCloudAgentRecoveryStatus = "cloud-retry-required",
    ): AgentSessionRecoveryStatus => (isManagedNative ? managedStatus : "idle");
    const showFallback = (
      managedStatus: ManagedCloudAgentRecoveryStatus = "cloud-retry-required",
    ) => {
      attemptedFallbackRef.current = managedStatus;
      awaitingCloudTokenRef.current =
        isManagedNative && managedStatus === "cloud-reauth-required";
      setStatus(fallbackStatus(managedStatus));
    };

    if (!active) {
      awaitingCloudTokenRef.current = false;
      if (isAuthenticated) {
        attemptedRef.current = false;
        attemptedFallbackRef.current = "cloud-retry-required";
      }
      setStatus("idle");
      return;
    }

    if (attemptedRef.current) {
      // One attempt per cycle: a prior failed attempt must fall through to the
      // wall/notice, never loop.
      setStatus(fallbackStatus(attemptedFallbackRef.current));
      return;
    }

    let cancelled = false;
    let recoveryServer = activeServer;
    const clientBase = client.getBaseUrl();
    const clientRevision = client.getAuthorityRevision();
    const recoveryAbortController = new AbortController();
    const coordinator = getStewardTabSessionAuthorityCoordinator();
    let expected: StewardSessionAuthoritySnapshot;
    try {
      expected = coordinator.readSnapshot();
    } catch {
      // error-policy:J4 inaccessible account authority requires a visible retry.
      showFallback("cloud-retry-required");
      return;
    }
    const cloudApiBase =
      getBootConfig().cloudApiBase?.trim() || "https://eliza.app";
    const validateLifetime = () => {
      if (
        recoveryAbortController.signal.aborted ||
        client.getBaseUrl() !== clientBase ||
        client.getAuthorityRevision() !== clientRevision ||
        (getBootConfig().cloudApiBase?.trim() || "https://eliza.app") !==
          cloudApiBase
      )
        throw new StewardSessionAuthorityError(
          "Agent recovery target changed",
          "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
        );
    };
    const validateTarget = () => {
      validateLifetime();
      if (
        !recoveryServer ||
        !recoveryTargetMatches(recoveryServer, loadPersistedActiveServer())
      )
        throw new StewardSessionAuthorityError(
          "Agent recovery selection changed",
          "STEWARD_SESSION_AUTHORITY_SUPERSEDED",
        );
    };
    const cancelOnPagehide = () => {
      cancelled = true;
      recoveryAbortController.abort();
      showFallback("cloud-retry-required");
    };
    const cleanupRecovery = () => {
      cancelled = true;
      recoveryAbortController.abort();
      window.removeEventListener("pagehide", cancelOnPagehide);
    };

    const resolveInput = (
      cloudToken: string | null,
      // The outer attempt guard lives on `attemptedRef`; this flag is for the
      // resolver's own loop-guard. When re-resolving AFTER a successful cookie
      // refresh we pass `false` so the freshly-recovered token can re-pair (the
      // refresh IS this cycle's one attempt, gated by the caller).
      alreadyAttempted: boolean = attemptedRef.current,
    ) => ({
      reason,
      activeServer,
      cloudToken,
      cloudApiBase,
      alreadyAttempted,
    });

    const startRepair = (
      decision: ReturnType<typeof resolveAgentSessionRecovery>,
      cloudToken: string,
    ) => {
      awaitingCloudTokenRef.current = false;
      if (decision.action !== "re-pair") {
        showFallback(
          cloudToken.trim() ? "cloud-manage-required" : "cloud-reauth-required",
        );
        return;
      }
      if (!activeServer) {
        showFallback("cloud-manage-required");
        return;
      }
      attemptedFallbackRef.current = "cloud-retry-required";
      setStatus("recovering");
      const isRecoveryTargetCurrent = () => {
        try {
          validateTarget();
          coordinator.assertSnapshot(expected);
          return (
            resolveDedicatedAgentId(activeServer) === decision.agentId &&
            getCloudAuthToken()?.trim() === cloudToken.trim()
          );
        } catch {
          // error-policy:J4 the runner exposes cancellation instead of acting on a stale target.
          return false;
        }
      };
      void runAgentSessionRecovery({
        cloudApiBase: decision.cloudApiBase,
        agentId: decision.agentId,
        cloudToken,
        consumeRedirectInProcess,
        signal: recoveryAbortController.signal,
        isRecoveryTargetCurrent,
        clearStalePairCredentials: () =>
          clearStalePairCredentialsForAgent(decision.agentId),
        commitPairedInProcess: async (apiToken) => {
          if (!isRecoveryTargetCurrent()) {
            recoveryAbortController.abort();
            throw new Error(
              "Agent session recovery target changed before credential commit",
            );
          }
          await persistActiveServerCredential(apiToken, undefined, {
            revalidate: () => {
              validateLifetime();
              coordinator.assertSnapshot(expected);
            },
          });
          recoveryServer = { ...activeServer, accessToken: apiToken };
          validateTarget();
          coordinator.assertSnapshot(expected);
          // No live bearer or pairing event precedes the acknowledged guarded
          // write; publication and re-probe stay in this final synchronous turn.
          persistCloudPairApiToken(apiToken, decision.agentId);
          client.setToken(apiToken);
          onRecovered?.();
        },
        navigate,
      })
        .then((result) => {
          if (cancelled) return;
          // Browser success navigates through `/pair`; native success installs
          // the bearer in-process and triggers `onRecovered`. Failures retain
          // enough classification for reauth versus non-destructive retry.
          if (!result.ok) {
            if (result.reason === "cancelled") {
              attemptedRef.current = false;
              setStatus("idle");
              return;
            }
            logger.warn(
              {
                agentId: decision.agentId,
                reason: result.reason,
                message: result.message,
              },
              "[AgentSessionRecovery] managed-agent re-pair failed",
            );
            showFallback(
              result.reason === "unauthorized"
                ? "cloud-reauth-required"
                : result.reason === "manage-required"
                  ? "cloud-manage-required"
                  : "cloud-retry-required",
            );
          } else {
            logger.info(
              {
                agentId: decision.agentId,
                mode: result.mode,
              },
              "[AgentSessionRecovery] managed-agent re-pair succeeded",
            );
          }
        })
        .catch((error: unknown) => {
          // error-policy:J4 an unclassified repair failure keeps the existing
          // Cloud token and degrades to a non-destructive retry surface.
          if (!cancelled) {
            logger.warn(
              {
                agentId: decision.agentId,
                error:
                  error instanceof Error
                    ? error.message
                    : "Unknown recovery failure",
              },
              "[AgentSessionRecovery] managed-agent re-pair threw",
            );
            showFallback("cloud-retry-required");
          }
        });
    };

    const initialInput = resolveInput(cloudTokenSnapshot);
    const initialDecision = resolveAgentSessionRecovery(initialInput);
    const initialCloudToken = initialInput.cloudToken?.trim();

    if (initialDecision.action === "re-pair" && initialCloudToken) {
      // Fast path: app-origin cloud token already present, re-pair immediately
      // (the classic post-upgrade stale-credential case).
      attemptedRef.current = true;
      window.addEventListener("pagehide", cancelOnPagehide);
      startRepair(initialDecision, initialCloudToken);
      return cleanupRecovery;
    }

    if (!agentSessionRepairNeedsCloudToken(initialInput)) {
      // Not a cookie-recoverable state (self-hosted, wrong 401 reason, no agent
      // id, or genuinely nothing to re-pair). The wall/notice is honest.
      showFallback(
        initialInput.cloudToken?.trim()
          ? "cloud-manage-required"
          : "cloud-reauth-required",
      );
      return;
    }

    // Re-pair-shaped in every dimension EXCEPT the app-origin cloud token: this
    // is the returning-PWA "Open this agent from Eliza Cloud" dead-end. The user
    // IS signed in to Eliza (through the canonical host's HttpOnly cookie), but
    // this origin's token mirror is empty. Recover the session through the
    // same-origin refresh bridge and re-pair instead of dropping to the notice.
    attemptedRef.current = true;
    setStatus("recovering");
    window.addEventListener("pagehide", cancelOnPagehide);

    void ensureCloudSessionForRepair({
      signal: recoveryAbortController.signal,
      beforePublish: validateTarget,
      // This effect owns the pairing continuation; rearming it from its own
      // publication would clean up and cancel that very continuation.
      emitSyncEvent: false,
    })
      .then((token) => {
        if (cancelled) return;
        if (!token) {
          validateTarget();
          coordinator.assertSnapshot(expected);
          // No cookie / refresh failed / timed out: the notice is honest now.
          showFallback("cloud-reauth-required");
          // Native SIWE can finish in the narrow window between the cookie
          // refresh resolving and the fallback being armed. Its sync event has
          // already fired, so re-check the canonical token once instead of
          // waiting forever for a second event.
          const lateCloudToken = getCloudAuthToken();
          if (awaitingCloudTokenRef.current && lateCloudToken?.trim()) {
            awaitingCloudTokenRef.current = false;
            attemptedRef.current = false;
            setCloudTokenSnapshot(lateCloudToken);
          }
          return;
        }
        validateTarget();
        const recovered = { ...expected, token };
        coordinator.assertSnapshot(recovered);
        expected = recovered;
        // Pair installation broadcasts the account sync event too. It must
        // not rearm this effect for the cookie token it has just recovered.
        observedCloudTokenRef.current = token;
        const decision = resolveAgentSessionRecovery(
          resolveInput(token, false),
        );
        startRepair(decision, token);
      })
      .catch((error) => {
        // error-policy:J4 cookie recovery is opportunistic; the explicit Cloud
        // reauthentication notice remains the safe user-driven fallback.
        if (!cancelled)
          showFallback(
            error instanceof StewardSessionAuthorityError
              ? "cloud-retry-required"
              : "cloud-reauth-required",
          );
      });

    return cleanupRecovery;
    // setStatus and attemptedRef are stable; all third-party inputs are listed.
  }, [
    active,
    reason,
    navigate,
    onRecovered,
    isAuthenticated,
    cloudTokenSnapshot,
  ]);

  return status;
}
