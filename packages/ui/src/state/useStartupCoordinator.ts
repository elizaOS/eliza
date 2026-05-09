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
import { isElectrobunRuntime } from "../bridge";
import { isAndroid, isElizaOS, isNative } from "../platform";
import { loadPersistedOnboardingComplete } from "./persistence";
import {
  createAndroidPolicy,
  createDesktopPolicy,
  createElizaOSPolicy,
  createMobilePolicy,
  createWebPolicy,
  INITIAL_STARTUP_STATE,
  isStartupLoading,
  isStartupTerminal,
  type PlatformPolicy,
  type RuntimeTarget,
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
  onboardingComplete: () => void;
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

  // ── Phase: splash — auto-skip for returning users, mark loaded for new users
  // Fresh installs stay on splash until the user explicitly continues.
  useEffect(() => {
    if (state.phase !== "splash") return;
    if (!depsReady) return;

    if (loadPersistedOnboardingComplete()) {
      dispatch({ type: "SPLASH_CONTINUE" });
      return;
    }
    dispatch({ type: "SPLASH_LOADED" });
  }, [state.phase, depsReady]);

  // ── Phase: restoring-session ────────────────────────────────────
  useEffect(() => {
    if (state.phase !== "restoring-session" || !depsReady) return;
    const d = depsRef.current;
    if (!d) return;
    effectRunRef.current += 1;
    const cancelled = { current: false };

    runRestoringSession(d, dispatch, _ctx, cancelled).catch((err) => {
      console.error("[eliza][startup:restore] Unexpected error:", err);
    });

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
    ).catch((err) => {
      console.error("[eliza][startup:poll] Unexpected error:", err);
    });

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
    ).catch((err) => {
      console.error("[eliza][startup:runtime] Unexpected error:", err);
    });

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

    runHydrating(currentDeps, dispatch, cancelled).catch((err) => {
      console.error("[eliza][startup:hydrate] Unexpected error:", err);
    });

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
  const onboardingCompleteFn = useCallback(
    () => dispatch({ type: "ONBOARDING_COMPLETE" }),
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
    onboardingComplete: onboardingCompleteFn,
    policy,
    legacyPhase: toLegacyStartupPhase(state),
    loading: isStartupLoading(state),
    terminal: isStartupTerminal(state),
    target,
    phase: state.phase,
  };
}
