/**
 * startup-phase-runtime.ts
 *
 * Side-effect logic for the "starting-runtime" startup phase.
 * Polls the agent status until running, then dispatches AGENT_RUNNING.
 */

import { type AgentStartupDiagnostics, client } from "../api";
import {
  computeAgentDeadlineExtensions,
  getAgentReadyTimeoutMs,
} from "./agent-startup-timing";
import {
  asApiLikeError,
  formatStartupErrorDetail,
  type StartupErrorState,
} from "./internal";
import type { StartupEvent } from "./startup-coordinator";

export interface StartingRuntimeDeps {
  setAgentStatus: (v: import("../api").AgentStatus | null) => void;
  setConnected: (v: boolean) => void;
  setStartupError: (v: StartupErrorState | null) => void;
  setOnboardingLoading: (v: boolean) => void;
  setAuthRequired: (v: boolean) => void;
  setPairingEnabled: (v: boolean) => void;
  setPairingExpiresAt: (v: number | null) => void;
  setPendingRestart: (v: boolean | ((prev: boolean) => boolean)) => void;
  setPendingRestartReasons: (
    v: string[] | ((prev: string[]) => string[]),
  ) => void;
}

/**
 * Runs the starting-runtime phase.
 * Polls /status until the agent reaches "running", then dispatches AGENT_RUNNING.
 *
 * @param deps - Coordinator dependency bag
 * @param dispatch - startupReducer dispatch
 * @param effectRunId - The run ID of the calling effect (for stale-close guard)
 * @param effectRunRef - Shared ref tracking the latest run ID
 * @param cancelled - Ref-flag set true by the cleanup function
 * @param tidRef - Mutable ref for the pending setTimeout handle (for cleanup)
 */
export async function runStartingRuntime(
  deps: StartingRuntimeDeps,
  dispatch: (event: StartupEvent) => void,
  effectRunId: number,
  effectRunRef: React.MutableRefObject<number>,
  cancelled: { current: boolean },
  tidRef: { current: ReturnType<typeof setTimeout> | null },
): Promise<void> {
  const describeAgentFailure = (
    err: unknown,
    timedOut: boolean,
    diag?: AgentStartupDiagnostics,
  ): StartupErrorState => {
    const detail =
      diag?.lastError ||
      formatStartupErrorDetail(err) ||
      "Agent runtime did not report a reason.";
    if (
      !timedOut &&
      /required companion assets could not be loaded|bundled avatar .* could not be loaded/i.test(
        detail,
      )
    )
      return {
        reason: "asset-missing",
        phase: "initializing-agent",
        message: "Required companion assets could not be loaded.",
        detail,
      };
    if (timedOut) {
      const hint =
        'First-time startup often downloads a local embedding model (GGUF, hundreds of MB). That can take many minutes on a slow network.\n\nIf logs still show a download in progress, wait for it to finish, then tap Retry. On desktop, the app keeps extending the wait while the agent stays in "starting" (up to 15 minutes total).';
      const emb =
        diag?.embeddingDetail ??
        (diag?.embeddingPhase === "downloading"
          ? "Embedding model download in progress."
          : undefined);
      return {
        reason: "agent-timeout",
        phase: "initializing-agent",
        message:
          "The agent did not become ready in time. This is common while a large embedding model (GGUF) is still downloading on first run.",
        detail: [detail, emb, hint]
          .filter(
            (b): b is string => typeof b === "string" && b.trim().length > 0,
          )
          .join("\n\n"),
      };
    }
    return {
      reason: "agent-error",
      phase: "initializing-agent",
      message: "Agent runtime reported a startup error.",
      detail,
    };
  };

  const started = Date.now();
  let deadline = started + getAgentReadyTimeoutMs();
  let lastErr: unknown = null;
  let lastDiag: AgentStartupDiagnostics | undefined;

  while (!cancelled.current && effectRunRef.current === effectRunId) {
    if (Date.now() >= deadline) {
      deps.setStartupError(describeAgentFailure(lastErr, true, lastDiag));
      deps.setOnboardingLoading(false);
      dispatch({ type: "AGENT_TIMEOUT" });
      return;
    }
    try {
      let status = await client.getStatus();
      deps.setAgentStatus(status);
      deps.setConnected(true);
      lastDiag = status.startup;
      deadline = computeAgentDeadlineExtensions({
        agentWaitStartedAt: started,
        agentDeadlineAt: deadline,
        state: status.state,
      });
      if (status.pendingRestart) {
        deps.setPendingRestart(true);
        deps.setPendingRestartReasons(status.pendingRestartReasons ?? []);
      }
      if (status.state === "not_started" || status.state === "stopped") {
        try {
          status = await client.startAgent();
          deps.setAgentStatus(status);
          lastDiag = status.startup;
        } catch (e: unknown) {
          lastErr = e;
        }
      }
      if (status.state === "running") {
        dispatch({ type: "AGENT_RUNNING" });
        return;
      }
      if (status.state === "error") {
        deps.setStartupError(
          describeAgentFailure(lastErr, false, status.startup),
        );
        deps.setOnboardingLoading(false);
        dispatch({
          type: "AGENT_ERROR",
          message: status.startup?.lastError ?? "Agent failed to start",
        });
        return;
      }
    } catch (err) {
      const ae = asApiLikeError(err);
      if (ae?.status === 401 && !client.hasToken()) {
        const auth = await client.getAuthStatus().catch(() => ({
          required: true,
          pairingEnabled: false,
          expiresAt: null,
        }));
        deps.setAuthRequired(true);
        deps.setPairingEnabled(auth.pairingEnabled);
        deps.setPairingExpiresAt(auth.expiresAt);
        deps.setOnboardingLoading(false);
        dispatch({ type: "BACKEND_AUTH_REQUIRED" });
        return;
      }
      if ((ae?.status === 401 || ae?.status === 429) && client.hasToken()) {
        // 401/429 with a token. Two flavors to distinguish:
        //   1. Genuine port race / pre-bearer endpoint window — /api/auth/status
        //      itself isn't reachable yet. Keep retrying.
        //   2. Bearer-only token (paired but no password session). Server says
        //      /api/auth/status is fine (authenticated:true) but app endpoints
        //      like /api/agent/status still 401, or 429 from the auth rate
        //      limiter on those endpoints. /api/auth/me returns
        //      reason="remote_auth_required". Advance to ready so the auth gate
        //      can render LoginView. Hydrating tolerates 401s.
        try {
          const auth = await client.getAuthStatus();
          const remotePasswordMissing =
            auth.required &&
            auth.loginRequired &&
            auth.passwordConfigured === false;
          if (auth.authenticated || remotePasswordMissing) {
            deps.setOnboardingLoading(false);
            dispatch({ type: "AGENT_RUNNING" });
            return;
          }
        } catch {
          // /api/auth/status itself unreachable — keep retrying.
        }
      }
      lastErr = err;
      deps.setConnected(false);
    }
    await new Promise<void>((r) => {
      tidRef.current = setTimeout(r, 500);
    });
  }
}
