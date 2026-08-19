/**
 * startup-phase-runtime.ts
 *
 * Side-effect logic for the "starting-runtime" startup phase.
 * Polls the agent status until running, then dispatches AGENT_RUNNING.
 */

import { logger } from "@elizaos/logger";
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
import { isTerminalDedicatedCloudAgentErrorState } from "./dedicated-cloud-agent-error";
import {
  asApiLikeError,
  formatStartupErrorDetail,
  type StartupErrorState,
} from "./internal";
import {
  clearPersistedActiveServer,
  loadPersistedActiveServer,
} from "./persistence";
import type { RuntimeTarget, StartupEvent } from "./startup-coordinator";
import { runStartupProbe } from "./startup-probe";
import { STARTUP_TIMING_POLICY } from "./startup-timing-policy";

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
  setFirstRunComplete: (v: boolean) => void;
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
    if (status?.state !== "running") return;

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
 * True when the persisted active server is an Eliza-managed cloud agent
 * (`kind: "cloud"`). Written on every cloud entry path (first-run completion,
 * session restore, profile switch) and NEVER for the desktop/mobile embedded
 * agent (`kind: "local"`) or a self-hosted remote backend (`kind: "remote"`).
 *
 * This is the scope signal for the cold-boot warmup gate: only a managed cloud
 * agent reaches the app through the per-agent PROXY passthrough
 * (`/api/v1/eliza/agents/<id>/api/*`) that 404s "Agent not found" while the
 * container is still warming, so only a managed cloud agent needs the extra
 * passthrough confirmation before we declare the runtime ready. A pure
 * localStorage read — no deps threading, no state-machine change — so the
 * embedded-local and remote-backend paths keep their exact current behavior.
 */
function isCloudManagedActiveServer(): boolean {
  return loadPersistedActiveServer()?.kind === "cloud";
}

/**
 * Probes the genuine per-agent proxy passthrough for a managed cloud agent.
 *
 * The startup coordinator historically declared a cloud agent "ready" off the
 * cloud ORCHESTRATOR view (`getStatus()`, which for a direct shared-runtime base
 * is a client-side shim that hardcodes `state: "running"` — see
 * ElizaClient.getStatus). That reports running the instant the agent is
 * PROVISIONED, but the per-agent PROXY passthrough
 * (`/api/v1/eliza/agents/<id>/api/*`) still 404s "Agent not found" for the first
 * ~minutes while the container binds the runtime. Declaring ready off the shim
 * routed cold-boot cloud users to a washed-out /character/select instead of the
 * booting chat.
 *
 * `listConversations()` issues a real `GET /api/conversations` THROUGH that
 * passthrough (it is NOT short-circuited by any shim), so it is a strong
 * "is the warmed runtime actually serving?" signal — BUT it is not the ONLY
 * one, and a naive boolean over-trusts it (CONVERSATIONS-500-2026-07-22):
 *   - resolves → the passthrough serves → runtime is live → ready.
 *   - 404 "Agent not found" → still WARMING (container binding the runtime) →
 *     keep polling.
 *   - persistent 5xx → the runtime is UP but the conversations-list read is
 *     ERRORING (e.g. a scope-cache/date defect 500ing the list while /status
 *     stays 200). Treating this identically to a warming 404 strands a
 *     genuinely-serving agent on the boot screen until the absolute-max
 *     deadline. It must be classified distinctly so the warmup can (a) confirm
 *     readiness off /api/status instead, and (b) surface an actionable error
 *     rather than an infinite spinner if the whole surface stays broken.
 * A bearer can become stale after polling-backend has already advanced, so a
 * 401/429 with an adopted token must reach the auth gate instead of looking
 * like an indefinitely warming container.
 */
type PassthroughProbe =
  | { kind: "serving" }
  | { kind: "warming" }
  | { kind: "auth-required"; status: 401 | 429 }
  | { kind: "terminal-agent-error" }
  | { kind: "errored"; status: number };

async function probeCloudProxyPassthrough(): Promise<PassthroughProbe> {
  try {
    await client.listConversations();
    return { kind: "serving" };
  } catch (err) {
    const apiError = asApiLikeError(err);
    const status = apiError?.status;
    if (
      isTerminalDedicatedCloudAgentErrorState({
        status,
        code: apiError?.code,
        message: apiError?.message,
        clientBaseUrl: client.getBaseUrl(),
      })
    ) {
      return { kind: "terminal-agent-error" };
    }
    if ((status === 401 || status === 429) && client.hasToken()) {
      return { kind: "auth-required", status };
    }
    // A 5xx means the runtime answered but the list read errored — the agent is
    // likely UP (that is exactly the shared-agent conversations 500 class). Any
    // other failure (404 "Agent not found", network/timeout, no status) is
    // "still warming": keep polling as before.
    if (typeof status === "number" && status >= 500) {
      return { kind: "errored", status };
    }
    return { kind: "warming" };
  }
}

/**
 * Secondary readiness signal for a cloud-managed agent whose /api/conversations
 * passthrough is 5xx-ing: does /api/status through the SAME passthrough report a
 * runtime that can actually respond? A broken list endpoint must not strand a
 * genuinely-serving agent on the boot screen — if status says `canRespond`, the
 * agent is ready and the user should be let into chat (CONVERSATIONS-500).
 */
async function isCloudProxyStatusReady(): Promise<boolean> {
  try {
    const status = await client.fetch<AgentStatus>("/api/status", undefined, {
      timeoutMs: 30_000,
    });
    return status?.state === "running" && status?.canRespond === true;
  } catch {
    return false;
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
 * @param target - Resolved runtime target. "cloud-managed" / "remote-backend"
 *   means the agent is cloud-hosted (topology 3): skip client.startAgent() and
 *   the local agent-readiness loop entirely. Defaults to "embedded-local"
 *   (topologies 1 & 2), which keeps the original local boot/poll behavior.
 */
export async function runStartingRuntime(
  deps: StartingRuntimeDeps,
  dispatch: (event: StartupEvent) => void,
  effectRunId: number,
  effectRunRef: React.MutableRefObject<number>,
  cancelled: { current: boolean },
  tidRef: { current: ReturnType<typeof setTimeout> | null },
  target: RuntimeTarget = "embedded-local",
): Promise<void> {
  // Topology 3 (cloud-hosted agent): the agent already runs in the cloud
  // container the device is pointed at — there is no local runtime to start.
  // Calling client.startAgent() here would (at best) hit a remote endpoint
  // that has nothing to boot, and the local agent-readiness poll loop is
  // pure latency on the first-paint critical path. Topologies 1 & 2
  // ("embedded-local") fall through to the full boot/poll loop below.
  if (target === "cloud-managed" || target === "remote-backend") {
    if (cancelled.current || effectRunRef.current !== effectRunId) return;

    // For an Eliza-MANAGED cloud agent, "provisioned" is not "serving". The
    // orchestrator/status shim reports running the instant the agent is
    // provisioned, but the per-agent PROXY passthrough
    // (`/api/v1/eliza/agents/<id>/api/*`) 404s "Agent not found" for the first
    // ~minutes while the container binds the runtime. Declaring ready off the
    // shim routed the user to a washed-out /character/select instead of the
    // booting chat. Gate readiness on the passthrough genuinely serving so we
    // stay in starting-runtime (booting chat; a stuck boot surfaces as the
    // boot-recovery conductor's in-chat card) until the warmed runtime
    // actually answers. Scoped to `kind: "cloud"` — a
    // self-hosted `remote-backend` and the desktop/mobile embedded-local agent
    // never go through this passthrough, so they keep the immediate-ready
    // behavior unchanged.
    if (target === "cloud-managed" && isCloudManagedActiveServer()) {
      await runCloudManagedWarmup(
        deps,
        dispatch,
        effectRunId,
        effectRunRef,
        cancelled,
        tidRef,
      );
      return;
    }

    // Self-hosted remote backend (or a cloud-managed target with no persisted
    // cloud record): treat the already-running remote agent as ready and
    // advance straight to hydration — today's behavior, unchanged.
    await hydrateReadyAgentStatus(deps);
    if (cancelled.current || effectRunRef.current !== effectRunId) return;
    deps.setConnected(true);
    deps.setFirstRunLoading(false);
    logger.info(
      `[eliza][startup:init] cloud-hosted agent (${target}); skipping local agent startup`,
    );
    dispatch({ type: "AGENT_RUNNING" });
    return;
  }
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
      const launchProbe = await runStartupProbe(
        () => client.getLaunchProgress(),
        { unsupportedStatuses: [404] },
      );
      if (launchProbe.kind === "terminal-error") throw launchProbe.error;
      if (launchProbe.kind === "retryable-error") lastErr = launchProbe.error;
      const launchProgress =
        launchProbe.kind === "ok" ? launchProbe.value : null;
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
          tidRef.current = setTimeout(
            r,
            STARTUP_TIMING_POLICY.runtimePollIntervalMs,
          );
        });
        continue;
      }

      const bootProbe = await runStartupProbe(() => client.getBootProgress(), {
        unsupportedStatuses: [404],
      });
      if (bootProbe.kind === "terminal-error") throw bootProbe.error;
      if (bootProbe.kind === "retryable-error") lastErr = bootProbe.error;
      const bootProgress = bootProbe.kind === "ok" ? bootProbe.value : null;
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
          tidRef.current = setTimeout(
            r,
            STARTUP_TIMING_POLICY.runtimePollIntervalMs,
          );
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
          const authProbe = await runStartupProbe(() => client.getAuthStatus());
          if (authProbe.kind !== "ok") {
            lastErr = authProbe.error;
            continue;
          }
          const auth = authProbe.value;
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
        const authProbe = await runStartupProbe(() => client.getAuthStatus());
        if (authProbe.kind === "ok") {
          const auth = authProbe.value;
          const remotePasswordMissing =
            auth.required &&
            auth.loginRequired &&
            auth.passwordConfigured === false;
          if (auth.authenticated || remotePasswordMissing) {
            deps.setFirstRunLoading(false);
            dispatch({ type: "AGENT_RUNNING" });
            return;
          }
        } else {
          // The surrounding deadline owns recovery; retain the actual auth
          // probe failure so timeout diagnostics name the failing boundary.
          lastErr = authProbe.error;
        }
      }
      lastErr = err;
      deps.setConnected(false);
    }
    await new Promise<void>((r) => {
      tidRef.current = setTimeout(
        r,
        STARTUP_TIMING_POLICY.runtimePollIntervalMs,
      );
    });
  }
}

/**
 * Cold-boot warmup loop for an Eliza-MANAGED cloud agent (`kind: "cloud"`).
 *
 * Polls the genuine per-agent proxy passthrough (`GET /api/conversations` via
 * `client.listConversations()`) until it actually serves, THEN hydrates and
 * dispatches AGENT_RUNNING. Until then we stay in the starting-runtime phase,
 * which renders the booting chat (a stuck boot surfaces as the boot-recovery
 * conductor's in-chat card) rather than flipping ready and routing the user
 * to a washed-out /character/select while the container is still warming.
 *
 * Deadline handling mirrors the local boot loop: start with the web policy's
 * 180s budget, then — while the passthrough is still warming — slide the
 * deadline forward with an effective "starting" state (the passthrough IS the
 * agent starting) so a legitimately slow warm (minutes) is not tripped as a
 * timeout. The slide is bounded by AGENT_STARTUP_ABSOLUTE_MAX_MS, so a genuinely
 * stuck agent still ends on the friendly agent-timeout screen instead of an
 * infinite spinner.
 *
 * Scoped strictly to managed cloud: this function is only reached from the
 * cloud-managed + persisted-cloud branch, so the desktop/mobile embedded-local
 * first-run and the self-hosted remote-backend paths are entirely unaffected.
 */
async function runCloudManagedWarmup(
  deps: StartingRuntimeDeps,
  dispatch: (event: StartupEvent) => void,
  effectRunId: number,
  effectRunRef: React.MutableRefObject<number>,
  cancelled: { current: boolean },
  tidRef: { current: ReturnType<typeof setTimeout> | null },
): Promise<void> {
  const started = Date.now();
  let deadline = started + getAgentReadyTimeoutMs();
  // Count CONSECUTIVE 5xx probes of the conversations passthrough. A persistent
  // 5xx (runtime up, list read broken) is NOT a warming 404 and must not spin
  // "initializing agent" forever: after a short streak we (a) confirm readiness
  // off /api/status so a broken list endpoint can't strand a serving agent, and
  // (b) if status also can't confirm, surface an actionable error with Retry
  // instead of an infinite spinner (CONVERSATIONS-500-2026-07-22).
  let consecutive5xx = 0;
  // ~5 consecutive 5xx at the 500ms poll cadence (~2.5s of deterministic errors)
  // is well past any single transient blip and safely distinguishes a real
  // broken-list-endpoint from a one-off flake before we act on it.
  const PERSISTENT_5XX_THRESHOLD = 5;

  const advanceReady = async (via: string): Promise<void> => {
    await hydrateReadyAgentStatus(deps);
    if (cancelled.current || effectRunRef.current !== effectRunId) return;
    deps.setConnected(true);
    deps.setFirstRunLoading(false);
    logger.info(
      `[eliza][startup:init] cloud-managed agent ready (${via}); advancing to chat`,
    );
    dispatch({ type: "AGENT_RUNNING" });
  };

  const advanceAuthGate = (): void => {
    deps.setConnected(false);
    deps.setFirstRunLoading(false);
    dispatch({ type: "AGENT_RUNNING" });
  };

  logger.info(
    "[eliza][startup:init] cloud-managed agent; waiting on proxy passthrough to warm before declaring ready",
  );

  while (!cancelled.current && effectRunRef.current === effectRunId) {
    if (Date.now() >= deadline) {
      deps.setStartupError({
        reason: "agent-timeout",
        phase: "initializing-agent",
        message:
          "The cloud agent did not finish starting in time. Cloud agents can take a few minutes to warm up on first launch.",
        detail:
          'The agent\'s chat endpoint was still returning "Agent not found" when the startup budget elapsed. Press Retry to keep waiting.',
      });
      deps.setFirstRunLoading(false);
      dispatch({ type: "AGENT_TIMEOUT" });
      return;
    }

    // Both requests traverse the genuine per-agent proxy. A direct
    // `/api/status` response with `running + canRespond` is as authoritative as
    // a successful conversation list and is substantially cheaper for a
    // returning shared Cloud agent whose list endpoint is cold or slow. Run
    // them concurrently so startup pays one proxy wake, not serial 10-second
    // timeouts. The status request has a 30s budget because production shared
    // runtimes regularly answer just beyond the generic 10s client timeout.
    const conversationProbe = probeCloudProxyPassthrough();
    const statusProbe = isCloudProxyStatusReady();
    const firstDecisive = await Promise.race([
      conversationProbe.then((probe) =>
        probe.kind === "serving"
          ? "conversations"
          : probe.kind === "auth-required"
            ? "auth-required"
            : null,
      ),
      statusProbe.then((ready) => (ready ? "status" : null)),
    ]);
    if (cancelled.current || effectRunRef.current !== effectRunId) return;

    if (firstDecisive === "status") {
      await advanceReady("status reports running and canRespond");
      return;
    }

    if (firstDecisive === "conversations") {
      // The passthrough answers → the warmed runtime is genuinely serving.
      await advanceReady("conversations passthrough serving");
      return;
    }

    if (firstDecisive === "auth-required") {
      // Authentication is a definitive routing result; a concurrent status
      // probe cannot make the adopted bearer valid. Mount the auth gate now
      // instead of waiting through the status request's 30-second budget.
      advanceAuthGate();
      return;
    }

    // The first request completed without proving readiness. Await the other
    // already-running request before classifying the iteration; this preserves
    // the existing auth/error handling without making a positive fast signal
    // wait for the slower endpoint.
    const [probe, statusReady] = await Promise.all([
      conversationProbe,
      statusProbe,
    ]);
    if (cancelled.current || effectRunRef.current !== effectRunId) return;

    if (statusReady) {
      await advanceReady("status reports running and canRespond");
      return;
    }

    if (probe.kind === "serving") {
      await advanceReady("conversations passthrough serving");
      return;
    }

    if (probe.kind === "auth-required") {
      // The passthrough is reachable and rejected the bearer. Advancing mounts
      // the normal auth gate, where managed Cloud recovery can exchange a
      // fresh agent credential; treating this as warmup would hide that gate
      // behind the startup screen until the absolute timeout.
      advanceAuthGate();
      return;
    }

    if (probe.kind === "terminal-agent-error") {
      // The selected sandbox cannot recover through polling or Retry. Remove
      // the poisoned persisted target and return to the Cloud agent picker,
      // which keeps the switcher reachable without rebinding to another host.
      clearPersistedActiveServer();
      client.setBaseUrl(null);
      client.setToken(null);
      deps.setConnected(false);
      deps.setFirstRunComplete(false);
      deps.setFirstRunLoading(false);
      dispatch({ type: "CLOUD_AGENT_SELECTION_REQUIRED" });
      return;
    }

    if (probe.kind === "errored") {
      // The runtime answered but the conversations-list read 5xx'd. The agent is
      // very likely UP (this is the shared-agent conversations 500 class). Do
      // NOT treat it as a warming 404.
      consecutive5xx += 1;
      if (consecutive5xx >= PERSISTENT_5XX_THRESHOLD) {
        // The concurrent status probe above already failed to confirm
        // readiness. Do not issue the same potentially slow request a second
        // time in this iteration.
        // Runtime is up (5xx, not 404) but neither the list read nor /status
        // can confirm it can serve. Surface an ACTIONABLE error with Retry
        // instead of spinning "initializing agent" to the absolute-max deadline.
        const errorMessage =
          "The agent is running but its chat service returned an error.";
        logger.error(
          `[eliza][startup:init] cloud-managed conversations passthrough persistently ${probe.status} and /api/status could not confirm readiness; surfacing agent error`,
        );
        deps.setStartupError({
          reason: "agent-error",
          phase: "initializing-agent",
          message: errorMessage,
          detail: `The agent's conversations endpoint responded with a server error (HTTP ${probe.status}) and /api/status could not confirm it can respond. This is a server-side issue, not a slow warmup. Press Retry to try again.`,
          status: probe.status,
        });
        deps.setFirstRunLoading(false);
        dispatch({ type: "AGENT_ERROR", message: errorMessage });
        return;
      }
      // Below the streak threshold: could still be a transient blip. Keep
      // polling WITHOUT sliding the deadline (a real 5xx is not "more warmup").
      deps.setConnected(false);
      await new Promise<void>((r) => {
        tidRef.current = setTimeout(
          r,
          STARTUP_TIMING_POLICY.runtimePollIntervalMs,
        );
      });
      continue;
    }

    // probe.kind === "warming": still warming (404 "Agent not found") or a
    // transient non-5xx failure. Reset the 5xx streak, keep polling, and —
    // because the passthrough not-yet-serving IS the agent still starting —
    // slide the deadline with an effective "starting" state so the warm window
    // can extend up to the absolute max instead of tripping the initial timeout.
    consecutive5xx = 0;
    deps.setConnected(false);
    deadline = computeAgentDeadlineExtensions({
      agentWaitStartedAt: started,
      agentDeadlineAt: deadline,
      state: "starting",
    });

    await new Promise<void>((r) => {
      tidRef.current = setTimeout(
        r,
        STARTUP_TIMING_POLICY.runtimePollIntervalMs,
      );
    });
  }
}
