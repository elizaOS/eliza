/**
 * useStartupCoordinator — React hook that drives the StartupCoordinator
 * state machine with side effects.
 *
 * This hook is the SOLE startup authority. It:
 * 1. Uses useReducer with the coordinator's startupReducer
 * 2. Delegates per-phase work to phase modules (startup-phase-*.ts)
 * 3. Dispatches events as async operations complete
 * 4. Syncs coordinator state to the legacy lifecycle setters
 *
 * Architecture: Each phase is handled by a dedicated function imported from
 * a phase module. One-time hydration work runs in the "hydrating" effect.
 * Persistent WS bindings and navigation listeners are set up via bindReadyPhase
 * in a "ready" effect that only cleans up on unmount (not on phase transitions).
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import { client } from "../api";
import { isElectrobunRuntime } from "../bridge";
import { isAndroid, isElizaOS, isIOS, isNative } from "../platform";
import {
  createAndroidPolicy,
  createDesktopPolicy,
  createElizaOSPolicy,
  createIosPolicy,
  createMobilePolicy,
  createWebPolicy,
  INITIAL_STARTUP_STATE,
  isStartupLoading,
  isStartupTerminal,
  type PlatformPolicy,
  type RuntimeTarget,
  type StartupErrorReason,
  type StartupEvent,
  type StartupState,
  startupReducer,
  toLegacyStartupPhase,
} from "./startup-coordinator";
import {
  bindReadyPhase,
  type HydratingDeps,
  type ReadyPhaseDeps,
  runHydrating,
} from "./startup-phase-hydrate";
import {
  type PollingBackendDeps,
  runPollingBackend,
} from "./startup-phase-poll";
import {
  type RestoringSessionCtx,
  type RestoringSessionDeps,
  runRestoringSession,
} from "./startup-phase-restore";
import {
  runStartingRuntime,
  type StartingRuntimeDeps,
} from "./startup-phase-runtime";

// Auto-recovery backoff: probe the backend after a transient startup error,
// backing off 2.5s → 5s → 10s → 20s → cap 30s, and give up after a bounded
// number of attempts so a genuinely-down backend stops thrashing and the user
// falls back to the manual Retry button.
const RECOVERY_BASE_DELAY_MS = 2_500;
const RECOVERY_MAX_DELAY_MS = 30_000;
const RECOVERY_MAX_ATTEMPTS = 8;

function isRecoverableStartupErrorReason(reason: StartupErrorReason): boolean {
  return (
    reason === "backend-timeout" ||
    reason === "backend-unreachable" ||
    reason === "agent-timeout" ||
    reason === "agent-error" ||
    reason === "unknown"
  );
}

export async function recoverTerminalStartupError(
  deps: StartupCoordinatorDeps,
  dispatch: (event: StartupEvent) => void,
  cancelled: { current: boolean },
): Promise<boolean> {
  let status: Awaited<ReturnType<typeof client.getStatus>>;
  try {
    status = await client.getStatus();
  } catch {
    return false;
  }
  if (cancelled.current || status.state !== "running") return false;

  let firstRunComplete = deps.firstRunCompletionCommittedRef.current;
  try {
    const firstRunStatus = await client.getFirstRunStatus();
    firstRunComplete = firstRunComplete || firstRunStatus.complete === true;
  } catch {
    return false;
  }
  if (cancelled.current) return false;

  deps.setAgentStatus(status);
  deps.setConnected(true);
  deps.setStartupError(null);
  deps.setFirstRunLoading(false);
  deps.setFirstRunComplete(firstRunComplete);

  if (firstRunComplete) {
    dispatch({ type: "AGENT_RUNNING" });
  } else {
    dispatch({ type: "BACKEND_REACHED", firstRunComplete: false });
  }
  return true;
}

// ── Deps interface ──────────────────────────────────────────────────
// Composed from per-phase slices defined in each startup-phase-*.ts module.
// The only member unique to the hook itself is `setStartupPhase` (legacy sync).

export type StartupCoordinatorDeps = RestoringSessionDeps &
  PollingBackendDeps &
  StartingRuntimeDeps &
  HydratingDeps &
  ReadyPhaseDeps & {
    /** Legacy lifecycle setter — driven by the coordinator sync effect. */
    setStartupPhase: (
      v: "starting-backend" | "initializing-agent" | "ready",
    ) => void;
  };

// ── Handle ──────────────────────────────────────────────────────────

export interface StartupCoordinatorHandle {
  state: StartupState;
  dispatch: (event: StartupEvent) => void;
  retry: () => void;
  reset: () => void;
  pairingSuccess: () => void;
  firstRunComplete: () => void;
  policy: PlatformPolicy;
  legacyPhase: "starting-backend" | "initializing-agent" | "ready";
  loading: boolean;
  terminal: boolean;
  target: RuntimeTarget | null;
  phase: StartupState["phase"];
}

function detectPlatformPolicy(): PlatformPolicy {
  if (isElectrobunRuntime()) return createDesktopPolicy();
  // ElizaOS check must come before the generic mobile branch — both are
  // native, but ElizaOS bundles the on-device agent and needs the longer
  // backend timeout (vanilla mobile is cloud-only with a fast-fail budget).
  if (isElizaOS()) return createElizaOSPolicy();
  if (isAndroid) return createAndroidPolicy();
  if (isIOS) return createIosPolicy();
  if (isNative) return createMobilePolicy();
  return createWebPolicy();
}

// ── Hook ────────────────────────────────────────────────────────────

export function useStartupCoordinator(
  deps?: StartupCoordinatorDeps,
): StartupCoordinatorHandle {
  const [state, dispatch] = useReducer(startupReducer, INITIAL_STARTUP_STATE);
  const policy = useRef(detectPlatformPolicy()).current;
  const effectRunRef = useRef(0);

  // Deps ref — effects always access latest deps without re-triggering
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const depsReady = deps != null;

  // Session context carried between restoring-session and polling-backend
  const _ctx = useRef<RestoringSessionCtx | null>(null);

  // Track whether the ready-phase WS bindings have been set up
  const wsBindingsActiveRef = useRef(false);

  // ── Legacy sync — derive startupPhase from coordinator state ────
  const legacyPhase = toLegacyStartupPhase(state);
  useEffect(() => {
    if (!depsReady) return;
    depsRef.current?.setStartupPhase(legacyPhase);
  }, [legacyPhase, depsReady]);

  // ── Phase: restoring-session ────────────────────────────────────
  useEffect(() => {
    if (state.phase !== "restoring-session" || !depsReady) return;
    const d = depsRef.current;
    if (!d) return;
    effectRunRef.current += 1;
    const cancelled = { current: false };

    runRestoringSession(d, dispatch, _ctx, cancelled).catch(() => {});

    return () => {
      cancelled.current = true;
    };
  }, [state.phase, depsReady]);

  // ── Phase: resolving-target (auto-advance) ──────────────────────
  useEffect(() => {
    if (state.phase !== "resolving-target") return;
    dispatch({ type: "BACKEND_POLL_RETRY" });
  }, [state.phase]);

  // ── Phase: polling-backend ──────────────────────────────────────
  useEffect(() => {
    if (state.phase !== "polling-backend" || !depsReady) return;
    const currentDeps = depsRef.current;
    if (!currentDeps) return;
    effectRunRef.current += 1;
    const runId = effectRunRef.current;
    const cancelled = { current: false };
    const tidRef = { current: null as ReturnType<typeof setTimeout> | null };

    runPollingBackend(
      currentDeps,
      dispatch,
      policy,
      _ctx.current,
      runId,
      effectRunRef,
      cancelled,
      tidRef,
    ).catch(() => {});

    return () => {
      cancelled.current = true;
      if (tidRef.current) clearTimeout(tidRef.current);
    };
  }, [state.phase, policy.backendTimeoutMs, depsReady, policy]);

  // ── Phase: starting-runtime ─────────────────────────────────────
  useEffect(() => {
    if (state.phase !== "starting-runtime" || !depsReady) return;
    const currentDeps = depsRef.current;
    if (!currentDeps) return;
    effectRunRef.current += 1;
    const runId = effectRunRef.current;
    const cancelled = { current: false };
    const tidRef = { current: null as ReturnType<typeof setTimeout> | null };

    runStartingRuntime(
      currentDeps,
      dispatch,
      runId,
      effectRunRef,
      cancelled,
      tidRef,
    ).catch(() => {});

    return () => {
      cancelled.current = true;
      if (tidRef.current) clearTimeout(tidRef.current);
    };
  }, [state.phase, depsReady]);

  // ── Phase: hydrating — one-time data load, then HYDRATION_COMPLETE ─
  useEffect(() => {
    if (state.phase !== "hydrating" || !depsReady) return;
    const currentDeps = depsRef.current;
    if (!currentDeps) return;
    const cancelled = { current: false };

    runHydrating(currentDeps, dispatch, cancelled).catch(() => {});

    return () => {
      cancelled.current = true;
    };
  }, [state.phase, depsReady]);

  // ── Ready phase — persistent WS bindings + nav listener ─────────
  // This effect runs once when the coordinator reaches "ready" and stays
  // active until the component unmounts. It does NOT depend on state.phase
  // after the guard, so phase transitions won't clean up WS bindings.
  const readyPhaseReached = state.phase === "ready";

  useEffect(() => {
    if (!readyPhaseReached || !depsReady) return;
    if (wsBindingsActiveRef.current) return; // Already bound
    wsBindingsActiveRef.current = true;

    const cleanup = bindReadyPhase(
      depsRef as React.MutableRefObject<ReadyPhaseDeps | undefined>,
    );

    return () => {
      wsBindingsActiveRef.current = false;
      cleanup();
    };
  }, [readyPhaseReached, depsReady]);

  // Desktop cold starts can briefly report an agent failure while the embedded
  // runtime is still settling, especially when the renderer loads before the
  // health/status routes are ready. Once the backend later reports a running
  // agent, recover automatically instead of leaving the user stuck on the
  // startup failure card until they manually press Retry.
  const errorReason: StartupErrorReason | null =
    state.phase === "error" ? state.reason : null;

  useEffect(() => {
    if (state.phase !== "error" || !depsReady) return;
    if (!isRecoverableStartupErrorReason(errorReason)) return;
    if (typeof window === "undefined") return;

    const currentDeps = depsRef.current;
    if (!currentDeps) return;
    const cancelled = { current: false };

    // Schedule probes with exponential backoff (2.5s → cap 30s) and stop after
    // a fixed number of attempts. Depending on `[state, ...]` here would
    // re-arm this loop on every dispatch (each mints a new state object),
    // turning a degraded backend into a perpetual probe storm that re-renders
    // every useApp() consumer. Gate on the specific primitives the effect uses;
    // other state fields are read through depsRef when a probe fires.
    let timer = 0;
    let attempt = 0;
    const scheduleNext = () => {
      if (cancelled.current || attempt >= RECOVERY_MAX_ATTEMPTS) return;
      const delay = Math.min(
        RECOVERY_BASE_DELAY_MS * 2 ** attempt,
        RECOVERY_MAX_DELAY_MS,
      );
      attempt += 1;
      timer = window.setTimeout(() => {
        void recoverTerminalStartupError(currentDeps, dispatch, cancelled)
          .then((recovered) => {
            // On success the dispatched event transitions out of "error", which
            // tears down this effect. Otherwise keep probing under backoff until
            // the attempt cap is reached, leaving the user-actionable Retry path.
            if (!recovered) scheduleNext();
          })
          .catch(() => {
            scheduleNext();
          });
      }, delay);
    };

    scheduleNext();

    return () => {
      cancelled.current = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [state.phase, errorReason, depsReady]);

  // ── Public interface ─────────────────────────────────────────────

  const retry = useCallback(() => dispatch({ type: "RETRY" }), []);
  const reset = useCallback(() => {
    _ctx.current = null;
    effectRunRef.current += 1;
    dispatch({ type: "RESET" });
  }, []);
  const pairingSuccess = useCallback(
    () => dispatch({ type: "PAIRING_SUCCESS" }),
    [],
  );
  const firstRunCompleteFn = useCallback(
    () => dispatch({ type: "FIRST_RUN_COMPLETE" }),
    [],
  );

  let target: RuntimeTarget | null = null;
  if (state.phase === "resolving-target") target = state.target;
  else if (state.phase === "polling-backend") target = state.target;

  return {
    state,
    dispatch,
    retry,
    reset,
    pairingSuccess,
    firstRunComplete: firstRunCompleteFn,
    policy,
    legacyPhase: toLegacyStartupPhase(state),
    loading: isStartupLoading(state),
    terminal: isStartupTerminal(state),
    target,
    phase: state.phase,
  };
}
