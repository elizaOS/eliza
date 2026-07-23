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
  agentSessionRepairNeedsCloudToken,
  resolveAgentSessionRecovery,
} from "../state/agent-session-recovery";
import { runAgentSessionRecovery } from "../state/agent-session-recovery-runner";
import { ensureCloudSessionForRepair } from "../state/cloud-session-refresh-for-repair";
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

function shouldConsumePairRedirectInProcess(): boolean {
  try {
    const cap = (globalThis as Record<string, unknown>).Capacitor as
      | { isNativePlatform?: () => boolean }
      | undefined;
    return Boolean(cap?.isNativePlatform?.());
  } catch {
    return false;
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

    if (attemptedRef.current) {
      // One attempt per cycle: a prior failed attempt must fall through to the
      // wall/notice, never loop.
      setStatus("idle");
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
      activeServer: loadPersistedActiveServer(),
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
        setStatus("idle");
        return;
      }
      setStatus("recovering");
      void runAgentSessionRecovery({
        cloudApiBase: decision.cloudApiBase,
        agentId: decision.agentId,
        cloudToken,
        consumeRedirectInProcess: shouldConsumePairRedirectInProcess(),
        onPairedInProcess: async (apiToken) => {
          const { client } = await import("../api");
          client.setToken(apiToken);
        },
        navigate,
      })
        .then((result) => {
          if (cancelled) return;
          // On success the runner triggers a full-page navigation to `/pair`,
          // so this component unmounts. On failure, drop to the wall.
          if (!result.ok) setStatus("idle");
        })
        .catch(() => {
          if (!cancelled) setStatus("idle");
        });
    };

    const initialInput = resolveInput(getCloudAuthToken());
    const initialDecision = resolveAgentSessionRecovery(initialInput);

    if (initialDecision.action === "re-pair") {
      // Fast path: app-origin cloud token already present, re-pair immediately
      // (the classic post-upgrade stale-credential case).
      attemptedRef.current = true;
      startRepair(initialDecision, getCloudAuthToken() as string);
      return () => {
        cancelled = true;
      };
    }

    if (!agentSessionRepairNeedsCloudToken(initialInput)) {
      // Not a cookie-recoverable state (self-hosted, wrong 401 reason, no agent
      // id, or genuinely nothing to re-pair). The wall/notice is honest.
      setStatus("idle");
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
          setStatus("idle");
          return;
        }
        const decision = resolveAgentSessionRecovery(
          resolveInput(token, false),
        );
        startRepair(decision, token);
      })
      .catch(() => {
        if (!cancelled) setStatus("idle");
      });

    return () => {
      cancelled = true;
    };
    // `active`/`reason`/`navigate` are the only third-party inputs; setStatus and
    // attemptedRef are stable, so the dependency list is exhaustive as written.
  }, [active, reason, navigate]);

  return status;
}
