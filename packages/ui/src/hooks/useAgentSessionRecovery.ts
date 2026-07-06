/**
 * useAgentSessionRecovery, bridges the unauthenticated auth state (#15132) to
 * a transparent re-pair instead of the password-wall dead-end.
 *
 * When `/api/auth/me` 401s AFTER a dedicated cloud agent's container upgrade,
 * the browser's persisted agent credential is stale but the cloud session is
 * still valid. This hook detects that exact case and re-runs the cloud pairing
 * exchange in the current window (the same flow first-pairing uses), which pins
 * a fresh credential and reloads onto `/` re-paired. In every other case (no
 * cloud session / self-hosted / already-attempted) it stays "idle" so the
 * top-level auth gate renders `LoginView` exactly as before.
 *
 * SECURITY (auth-adjacent): this NEVER bypasses the wall. Recovery only fires
 * when a valid cloud session exists to re-pair from; the server still gates the
 * pairing-token mint, and any 401/403 from it hands control back to the wall.
 */

import { useEffect, useRef, useState } from "react";
import { getCloudAuthToken } from "../api/client-cloud";
import { getBootConfig } from "../config/boot-config";
import {
  type AgentSessionUnauthReason,
  resolveAgentSessionRecovery,
} from "../state/agent-session-recovery";
import { runAgentSessionRecovery } from "../state/agent-session-recovery-runner";
import { loadPersistedActiveServer } from "../state/persistence";

export type AgentSessionRecoveryStatus =
  /** Not a recoverable state, the auth gate should render the wall. */
  | "idle"
  /** A re-pair is in flight, the auth gate should hold (no wall yet). */
  | "recovering";

interface UseAgentSessionRecoveryOptions {
  /**
   * Whether the app is currently in the unauthenticated state, and (when so)
   * the `/api/auth/me` reason. `active: false` disables the hook entirely.
   */
  active: boolean;
  reason: AgentSessionUnauthReason;
  /** Injected navigate (tests). Defaults to a full-page window assignment. */
  navigate?: (url: string) => void;
}

function defaultNavigate(url: string): void {
  if (typeof window !== "undefined") {
    window.location.assign(url);
  }
}

export function useAgentSessionRecovery(
  options: UseAgentSessionRecoveryOptions,
): AgentSessionRecoveryStatus {
  const { active, reason, navigate = defaultNavigate } = options;
  const [status, setStatus] = useState<AgentSessionRecoveryStatus>("idle");
  // One attempt per mount cycle: if re-pairing fails we must NOT retry into an
  // infinite loop, fall through to the wall instead.
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (!active) {
      // Reset when the app leaves the unauthenticated state (e.g. a successful
      // re-pair reloaded auth), so a later genuine 401 can recover again.
      attemptedRef.current = false;
      setStatus("idle");
      return;
    }

    const decision = resolveAgentSessionRecovery({
      reason,
      activeServer: loadPersistedActiveServer(),
      cloudToken: getCloudAuthToken(),
      cloudApiBase:
        getBootConfig().cloudApiBase?.trim() || "https://elizacloud.ai",
      alreadyAttempted: attemptedRef.current,
    });

    if (decision.action !== "re-pair") {
      // Nothing to recover, let the auth gate render the wall.
      setStatus("idle");
      return;
    }

    if (attemptedRef.current) return;
    attemptedRef.current = true;

    const cloudToken = getCloudAuthToken();
    if (!cloudToken) {
      setStatus("idle");
      return;
    }

    setStatus("recovering");
    let cancelled = false;

    void runAgentSessionRecovery({
      cloudApiBase: decision.cloudApiBase,
      agentId: decision.agentId,
      cloudToken,
      navigate,
    })
      .then((result) => {
        if (cancelled) return;
        // On success the runner triggers a full-page navigation to `/pair`, so
        // this component unmounts. On failure, drop to the wall.
        if (!result.ok) setStatus("idle");
      })
      .catch(() => {
        if (!cancelled) setStatus("idle");
      });

    return () => {
      cancelled = true;
    };
    // `active`/`reason`/`navigate` are the only external inputs; setStatus and
    // attemptedRef are stable, so the dependency list is exhaustive as written.
  }, [active, reason, navigate]);

  return status;
}
