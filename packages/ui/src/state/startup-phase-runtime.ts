/**
 * startup-phase-runtime.ts
 *
 * Side-effect logic for the "starting-runtime" startup phase.
 * Polls the agent status until running, then dispatches AGENT_RUNNING.
 */

import {
  type AgentBootProgress,
  type AgentStartupDiagnostics,
  type AgentStatus,
  client,
  type LaunchSnapshot,
} from "../api";
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

function isCapacitorNative(): boolean {
  try {
    const cap = (globalThis as Record<string, unknown>).Capacitor as
      | { isNativePlatform?: () => boolean }
      | undefined;
    return Boolean(cap?.isNativePlatform?.());
  } catch {
    return false;
  }
}

export interface StartingRuntimeDeps {
  setAgentStatus: (v: import("../api").AgentStatus | null) => void;
  setConnected: (v: boolean) => void;
  setStartupError: (v: StartupErrorState | null) => void;
  setFirstRunLoading: (v: boolean) => void;
  setAuthRequired: (v: boolean) => void;
  setPairingEnabled: (v: boolean) => void;
  setPairingExpiresAt: (v: number | null) => void;
  setPendingRestart: (v: boolean | ((prev: boolean) => boolean)) => void;
  setPendingRestartReasons: (
    v: string[] | ((prev: string[]) => string[]),
  ) => void;
}

function mapBootProgressToAgentStatus(
  progress: AgentBootProgress,
): AgentStatus {
  const startup: AgentStartupDiagnostics = {
    phase: progress.phase ?? progress.state,
    attempt: 0,
  };
  if (progress.lastError) {
    startup.lastError = progress.lastError;
  }
  return {
    state: progress.state,
    agentName: progress.agentName?.trim() || "Eliza",
    model: undefined,
    uptime:
      typeof progress.startedAt === "number"
        ? Math.max(0, Date.now() - progress.startedAt)
        : undefined,
    startedAt: progress.startedAt ?? undefined,
    port: progress.port ?? undefined,
    startup,
  };
}

function isRuntimeReadyFromBootProgress(progress: AgentBootProgress): boolean {
  return progress.state === "running" && progress.phase === "running";
}

function mapLaunchProgressToAgentStatus(progress: LaunchSnapshot): AgentStatus {
  const startup: AgentStartupDiagnostics = {
    phase: progress.phase,
    attempt: 0,
  };
  const lastError =
    progress.agent.error ||
    progress.auth.error ||
    progress.firstRun.error ||
    progress.localModel.error ||
    null;
  if (lastError) startup.lastError = lastError;
  return {
    state: progress.agent.state,
    agentName: "Eliza",
    model: undefined,
    uptime:
      typeof progress.agent.startedAt === "number"
        ? Math.max(0, Date.now() - progress.agent.startedAt)
        : undefined,
    startedAt: progress.agent.startedAt ?? undefined,
    port: progress.agent.port ?? undefined,
    startup,
  };
}

function isRuntimeReadyFromLaunchProgress(progress: LaunchSnapshot): boolean {
  return (
    progress.phase === "ready" ||
    (progress.agent.state === "running" &&
      progress.boot.runtimePhase === "running")
  );
}

/**
 * Fills in the full agent status once launch/boot progress reports the runtime
 * ready. Progress snapshots are enough to LEAVE startup, but they carry no
 * `model` field — without this, ChatView sees `model: undefined` and treats the
 * agent as having no configured provider, blocking the composer. Called after
 * the readiness check but before dispatching AGENT_RUNNING; a failed/slow
 * /status is non-fatal because the readiness decision has already been made.
 */
async function hydrateReadyAgentStatus(
  deps: StartingRuntimeDeps,
): Promise<void> {
  try {
    const status = await client.getStatus();
    if (!status || status.state !== "running") return;

    deps.setAgentStatus(status);
    if (status.pendingRestart) {
      deps.setPendingRestart(true);
      deps.setPendingRestartReasons(status.pendingRestartReasons ?? []);
    }
  } catch {
    // Progress snapshots are already enough to leave startup; full status
    // hydration is only needed when the status endpoint is ready too.
  }
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
        'First-time startup often downloads a local embedding model (GGUF, hundreds of MB). That can take many minutes on a slow network.\n\nIf logs still show a download in progress, wait for it to finish, then press Retry. On desktop, the app keeps extending the wait while the agent stays in "starting" (up to 15 minutes total).';
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
      deps.setFirstRunLoading(false);
      dispatch({ type: "AGENT_TIMEOUT" });
      return;
    }
    try {
      const launchProgress = await client.getLaunchProgress().catch(() => null);
      if (launchProgress) {
        const launchStatus = mapLaunchProgressToAgentStatus(launchProgress);
        deps.setAgentStatus(launchStatus);
        lastDiag = launchStatus.startup;

        if (launchProgress.phase === "pairing-required") {
          deps.setAuthRequired(true);
          deps.setPairingEnabled(launchProgress.auth.pairingEnabled === true);
          deps.setPairingExpiresAt(null);
          deps.setFirstRunLoading(false);
          dispatch({ type: "BACKEND_AUTH_REQUIRED" });
          return;
        }

        if (isRuntimeReadyFromLaunchProgress(launchProgress)) {
          await hydrateReadyAgentStatus(deps);
          deps.setConnected(true);
          dispatch({ type: "AGENT_RUNNING" });
          return;
        }

        if (
          launchProgress.agent.state === "not_started" ||
          launchProgress.agent.state === "stopped"
        ) {
          try {
            const status = await client.startAgent();
            deps.setAgentStatus(status);
            lastDiag = status.startup;
          } catch (e: unknown) {
            lastErr = e;
          }
        } else if (launchProgress.phase === "error") {
          deps.setStartupError(
            describeAgentFailure(lastErr, false, launchStatus.startup),
          );
          deps.setFirstRunLoading(false);
          dispatch({
            type: "AGENT_ERROR",
            message: launchStatus.startup?.lastError ?? "Agent failed to start",
          });
          return;
        } else {
          deadline = computeAgentDeadlineExtensions({
            agentWaitStartedAt: started,
            agentDeadlineAt: deadline,
            state: launchStatus.state,
          });
        }

        await new Promise<void>((r) => {
          tidRef.current = setTimeout(r, 500);
        });
        continue;
      }

      const bootProgress = await client.getBootProgress().catch(() => null);
      if (bootProgress) {
        const bootStatus = mapBootProgressToAgentStatus(bootProgress);
        deps.setAgentStatus(bootStatus);
        lastDiag = bootStatus.startup;

        if (isRuntimeReadyFromBootProgress(bootProgress)) {
          await hydrateReadyAgentStatus(deps);
          deps.setConnected(true);
          dispatch({ type: "AGENT_RUNNING" });
          return;
        }

        if (
          bootProgress.state === "not_started" ||
          bootProgress.state === "stopped"
        ) {
          try {
            const status = await client.startAgent();
            deps.setAgentStatus(status);
            lastDiag = status.startup;
          } catch (e: unknown) {
            lastErr = e;
          }
        } else if (bootProgress.state === "error") {
          deps.setStartupError(
            describeAgentFailure(lastErr, false, bootStatus.startup),
          );
          deps.setFirstRunLoading(false);
          dispatch({
            type: "AGENT_ERROR",
            message: bootStatus.startup?.lastError ?? "Agent failed to start",
          });
          return;
        } else {
          deadline = computeAgentDeadlineExtensions({
            agentWaitStartedAt: started,
            agentDeadlineAt: deadline,
            state: bootStatus.state,
          });
        }

        await new Promise<void>((r) => {
          tidRef.current = setTimeout(r, 500);
        });
        continue;
      }

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
        deps.setFirstRunLoading(false);
        dispatch({
          type: "AGENT_ERROR",
          message: status.startup?.lastError ?? "Agent failed to start",
        });
        return;
      }
    } catch (err) {
      const ae = asApiLikeError(err);
      if (ae?.status === 401 && !client.hasToken()) {
        // On Capacitor native the bearer token is injected asynchronously.
        // The first /api/status poll can race the injection and return 401
        // before the token is available. Fall through to retry on native;
        // dispatch BACKEND_AUTH_REQUIRED immediately on non-native runtimes
        // where there is no injection race.
        if (!isCapacitorNative()) {
          const auth = await client.getAuthStatus().catch(() => ({
            required: true,
            pairingEnabled: false,
            expiresAt: null,
          }));
          deps.setAuthRequired(true);
          deps.setPairingEnabled(auth.pairingEnabled);
          deps.setPairingExpiresAt(auth.expiresAt);
          deps.setFirstRunLoading(false);
          dispatch({ type: "BACKEND_AUTH_REQUIRED" });
          return;
        }
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
            deps.setFirstRunLoading(false);
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
