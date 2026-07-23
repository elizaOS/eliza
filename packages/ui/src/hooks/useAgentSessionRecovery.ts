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

import { useEffect, useRef, useState } from "react";
import { getCloudAuthToken } from "../api/client-cloud";
import { getBootConfig } from "../config/boot-config";
import {
  type AgentSessionUnauthReason,
  agentSessionRepairNeedsCloudToken,
  isManagedCloudAgentServer,
  type ManagedCloudAgentRecoveryStatus,
  resolveAgentSessionRecovery,
} from "../state/agent-session-recovery";
import { runAgentSessionRecovery } from "../state/agent-session-recovery-runner";
import { clearStalePairCredentialsForAgent } from "../state/cloud-pair-token";
import { ensureCloudSessionForRepair } from "../state/cloud-session-refresh-for-repair";
import { loadPersistedActiveServer } from "../state/persistence";
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

function shouldConsumePairRedirectInProcess(): boolean {
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

export function useAgentSessionRecovery(
  options: UseAgentSessionRecoveryOptions,
): AgentSessionRecoveryStatus {
  const { active, reason, navigate = defaultNavigate, onRecovered } = options;
  const [status, setStatus] = useState<AgentSessionRecoveryStatus>("idle");
  const isAuthenticated = useIsAuthenticated();
  // A loading refetch briefly leaves the unauthenticated state, so only a
  // confirmed session (or remount) may rearm recovery for a later genuine 401.
  const attemptedRef = useRef(false);
  const attemptedFallbackRef = useRef<ManagedCloudAgentRecoveryStatus>(
    "cloud-retry-required",
  );

  useEffect(() => {
    const consumeRedirectInProcess = shouldConsumePairRedirectInProcess();
    const activeServer = active ? loadPersistedActiveServer() : null;
    const isManagedNative =
      consumeRedirectInProcess && isManagedCloudAgentServer(activeServer);
    const fallbackStatus = (
      managedStatus: ManagedCloudAgentRecoveryStatus = "cloud-retry-required",
    ): AgentSessionRecoveryStatus => (isManagedNative ? managedStatus : "idle");
    const showFallback = (
      managedStatus: ManagedCloudAgentRecoveryStatus = "cloud-retry-required",
    ) => {
      attemptedFallbackRef.current = managedStatus;
      setStatus(fallbackStatus(managedStatus));
    };

    if (!active) {
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
      cloudApiBase:
        getBootConfig().cloudApiBase?.trim() || "https://elizacloud.ai",
      alreadyAttempted,
    });

    const startRepair = (
      decision: ReturnType<typeof resolveAgentSessionRecovery>,
      cloudToken: string,
    ) => {
      if (decision.action !== "re-pair") {
        showFallback(
          cloudToken.trim() ? "cloud-manage-required" : "cloud-reauth-required",
        );
        return;
      }
      attemptedFallbackRef.current = "cloud-retry-required";
      setStatus("recovering");
      void runAgentSessionRecovery({
        cloudApiBase: decision.cloudApiBase,
        agentId: decision.agentId,
        cloudToken,
        consumeRedirectInProcess,
        clearStalePairCredentials: () =>
          clearStalePairCredentialsForAgent(decision.agentId),
        onPairedInProcess: async (apiToken) => {
          const { client } = await import("../api");
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
            showFallback(
              result.reason === "unauthorized"
                ? "cloud-reauth-required"
                : result.reason === "manage-required"
                  ? "cloud-manage-required"
                  : "cloud-retry-required",
            );
          }
        })
        .catch(() => {
          // error-policy:J4 an unclassified repair failure keeps the existing
          // Cloud token and degrades to a non-destructive retry surface.
          if (!cancelled) showFallback("cloud-retry-required");
        });
    };

    const initialInput = resolveInput(getCloudAuthToken());
    const initialDecision = resolveAgentSessionRecovery(initialInput);
    const initialCloudToken = initialInput.cloudToken?.trim();

    if (initialDecision.action === "re-pair" && initialCloudToken) {
      // Fast path: app-origin cloud token already present, re-pair immediately
      // (the classic post-upgrade stale-credential case).
      attemptedRef.current = true;
      startRepair(initialDecision, initialCloudToken);
      return () => {
        cancelled = true;
      };
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
    // IS signed in to Eliza Cloud (shared HttpOnly `.elizacloud.ai` cookie), but
    // this origin's token mirror is empty. Recover the session from the cookie
    // silently and re-pair, instead of dropping to the terminal notice.
    attemptedRef.current = true;
    setStatus("recovering");

    void ensureCloudSessionForRepair()
      .then((token) => {
        if (cancelled) return;
        if (!token) {
          // No cookie / refresh failed / timed out: the notice is honest now.
          showFallback("cloud-reauth-required");
          return;
        }
        const decision = resolveAgentSessionRecovery(
          resolveInput(token, false),
        );
        startRepair(decision, token);
      })
      .catch(() => {
        // error-policy:J4 cookie recovery is opportunistic; the explicit Cloud
        // reauthentication notice remains the safe user-driven fallback.
        if (!cancelled) showFallback("cloud-reauth-required");
      });

    return () => {
      cancelled = true;
    };
    // setStatus and attemptedRef are stable; all third-party inputs are listed.
  }, [active, reason, navigate, onRecovered, isAuthenticated]);

  return status;
}
