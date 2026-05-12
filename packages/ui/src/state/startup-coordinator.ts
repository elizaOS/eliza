/**
 * StartupCoordinator — pure state machine for application startup.
 *
 * Replaces the implicit state encoded across `startupPhase + authRequired +
 * onboardingNeedsOptions + startupError` with an explicit state machine.
 * Side effects (API calls, storage reads) are triggered by the consumer
 * based on state transitions, not embedded in the machine itself.
 *
 * Design principles:
 * - States are explicit and exhaustive — no boolean flag combinations
 * - Transitions are pure functions: `(state, event) => state`
 * - Side effects live outside the machine (in the useEffect that drives it)
 * - Platform policy is injected, not hardcoded
 * - Same machine for desktop, web, and mobile — only policy differs
 */

import type { StartupErrorReason } from "./types";

// ── Platform Policy ──────────────────────────────────────────────────

export type RuntimeTarget =
  | "embedded-local"
  | "remote-backend"
  | "cloud-managed";

export interface PlatformPolicy {
  /** Can this platform run a local embedded agent? */
  supportsLocalRuntime: boolean;
  /** Backend poll timeout (ms) — desktop gets longer */
  backendTimeoutMs: number;
  /** Agent ready timeout (ms) — initial, before sliding extensions */
  agentReadyTimeoutMs: number;
  /** Should we probe for an existing local install on startup? */
  probeForExistingInstall: boolean;
  /** Default runtime target when nothing is persisted */
  defaultTarget: RuntimeTarget | null;
}

// ── State ────────────────────────────────────────────────────────────

export type StartupState =
  | { phase: "splash"; loaded: boolean }
  | { phase: "restoring-session" }
  | {
      phase: "resolving-target";
      target: RuntimeTarget;
    }
  | {
      phase: "polling-backend";
      target: RuntimeTarget;
      attempts: number;
    }
  | { phase: "pairing-required" }
  | {
      phase: "onboarding-required";
      /** true = server reachable, fetch options from it. false = first-run, use static options. */
      serverReachable: boolean;
    }
  | {
      phase: "starting-runtime";
      attempts: number;
    }
  | { phase: "hydrating" }
  | { phase: "ready" }
  | {
      phase: "error";
      reason: StartupErrorReason;
      message: string;
      timedOut: boolean;
    };

export type { StartupErrorReason };

export type StartupPhaseValue = StartupState["phase"];

// ── Events ───────────────────────────────────────────────────────────

export type StartupEvent =
  // Session restoration results
  | { type: "SESSION_RESTORED"; target: RuntimeTarget }
  | { type: "NO_SESSION"; hadPriorOnboarding: boolean }
  | { type: "EXISTING_INSTALL_DETECTED"; target: RuntimeTarget }

  // Backend poll results
  | { type: "BACKEND_REACHED"; onboardingComplete: boolean }
  | { type: "BACKEND_AUTH_REQUIRED" }
  | { type: "BACKEND_NOT_FOUND" }
  | { type: "BACKEND_TIMEOUT" }
  | { type: "BACKEND_POLL_RETRY" }

  // Onboarding
  | { type: "ONBOARDING_OPTIONS_LOADED" }
  | { type: "ONBOARDING_COMPLETE" }

  // Agent runtime
  | { type: "AGENT_RUNNING" }
  | { type: "AGENT_STARTING" }
  | { type: "AGENT_ERROR"; message: string }
  | { type: "AGENT_TIMEOUT" }
  | { type: "AGENT_POLL_RETRY" }

  // Hydration
  | { type: "HYDRATION_COMPLETE" }

  // User actions
  | { type: "RETRY" }
  | { type: "RESET" }
  | { type: "PAIRING_SUCCESS" }
  | { type: "SPLASH_CONTINUE" }
  | { type: "SPLASH_LOADED" }

  // Cloud fast-path: skip splash + restoring-session entirely
  | { type: "SPLASH_CLOUD_SKIP" }

  // Agent switching from within the app (e.g. Settings profile switcher)
  | { type: "SWITCH_AGENT"; target: RuntimeTarget };

// ── Reducer ──────────────────────────────────────────────────────────

export function startupReducer(
  state: StartupState,
  event: StartupEvent,
): StartupState {
  if (event.type === "RESET") {
    return INITIAL_STARTUP_STATE;
  }

  switch (state.phase) {
    case "splash":
      switch (event.type) {
        case "SPLASH_LOADED":
          return { phase: "splash", loaded: true };
        case "SPLASH_CONTINUE":
          return { phase: "restoring-session" };
        case "SPLASH_CLOUD_SKIP":
          // Cloud-provisioned containers skip splash + restoring-session
          // entirely. Jump straight to polling-backend so the existing
          // cloud-aware logic there handles onboarding bypass.
          return {
            phase: "polling-backend",
            target: "cloud-managed",
            attempts: 0,
          };
        case "RETRY":
          return { phase: "splash", loaded: false };
        default:
          return state;
      }

    case "restoring-session":
      switch (event.type) {
        case "SESSION_RESTORED":
          return { phase: "resolving-target", target: event.target };
        case "EXISTING_INSTALL_DETECTED":
          return { phase: "resolving-target", target: event.target };
        case "NO_SESSION":
          if (event.hadPriorOnboarding) {
            return {
              phase: "error",
              reason: "backend-unreachable",
              message:
                "Previously configured backend is unreachable. Check your connection or reset.",
              timedOut: false,
            };
          }
          return { phase: "onboarding-required", serverReachable: false };
        default:
          return state;
      }

    case "resolving-target":
      // Target is set — proceed to backend polling. The effect reads
      // state.target to configure the client base URL, then dispatches
      // BACKEND_REACHED or timeout events.
      return { phase: "polling-backend", target: state.target, attempts: 0 };

    case "polling-backend":
      switch (event.type) {
        case "BACKEND_REACHED":
          if (event.onboardingComplete) {
            return { phase: "starting-runtime", attempts: 0 };
          }
          return { phase: "onboarding-required", serverReachable: true };
        case "BACKEND_AUTH_REQUIRED":
          return { phase: "pairing-required" };
        case "BACKEND_NOT_FOUND":
          return {
            phase: "error",
            reason: "backend-unreachable",
            message: "Backend returned 404 — check the API base URL.",
            timedOut: false,
          };
        case "BACKEND_TIMEOUT":
          return {
            phase: "error",
            reason: "backend-timeout",
            message: "Backend did not respond within the timeout period.",
            timedOut: true,
          };
        case "BACKEND_POLL_RETRY":
          return { ...state, attempts: state.attempts + 1 };
        default:
          return state;
      }

    case "pairing-required":
      switch (event.type) {
        case "PAIRING_SUCCESS":
          return { phase: "restoring-session" };
        case "RETRY":
          return { phase: "restoring-session" };
        default:
          return state;
      }

    case "onboarding-required":
      switch (event.type) {
        case "ONBOARDING_OPTIONS_LOADED":
          return state; // Stay in onboarding — UI handles the wizard
        case "ONBOARDING_COMPLETE":
          return { phase: "starting-runtime", attempts: 0 };
        case "RETRY":
          return { phase: "restoring-session" };
        default:
          return state;
      }

    case "starting-runtime":
      switch (event.type) {
        case "AGENT_RUNNING":
          return { phase: "hydrating" };
        case "AGENT_STARTING":
        case "AGENT_POLL_RETRY":
          return { ...state, attempts: state.attempts + 1 };
        case "AGENT_ERROR":
          return {
            phase: "error",
            reason: "agent-error",
            message: event.message,
            timedOut: false,
          };
        case "AGENT_TIMEOUT":
          return {
            phase: "error",
            reason: "agent-timeout",
            message:
              "Agent did not reach running state within the timeout period.",
            timedOut: true,
          };
        case "BACKEND_AUTH_REQUIRED":
          return { phase: "pairing-required" };
        default:
          return state;
      }

    case "hydrating":
      switch (event.type) {
        case "HYDRATION_COMPLETE":
          return { phase: "ready" };
        default:
          return state;
      }

    case "ready":
      switch (event.type) {
        case "SWITCH_AGENT":
          // Switch to a different agent profile — re-enter polling
          return {
            phase: "polling-backend",
            target: event.target,
            attempts: 0,
          };
        default:
          return state;
      }

    case "error":
      switch (event.type) {
        case "RETRY":
          return { phase: "restoring-session" };
        default:
          return state;
      }

    default:
      return state;
  }
}

// ── Initial state ────────────────────────────────────────────────────

export const INITIAL_STARTUP_STATE: StartupState = {
  phase: "splash",
  loaded: false,
};

// ── Policy factories ─────────────────────────────────────────────────

export function createDesktopPolicy(): PlatformPolicy {
  return {
    supportsLocalRuntime: true,
    backendTimeoutMs: 180_000,
    agentReadyTimeoutMs: 300_000,
    probeForExistingInstall: true,
    defaultTarget: "embedded-local",
  };
}

export function createWebPolicy(): PlatformPolicy {
  return {
    supportsLocalRuntime: false,
    backendTimeoutMs: 30_000,
    agentReadyTimeoutMs: 180_000,
    probeForExistingInstall: false,
    defaultTarget: null,
  };
}

export function createMobilePolicy(): PlatformPolicy {
  return {
    supportsLocalRuntime: false,
    backendTimeoutMs: 15_000,
    agentReadyTimeoutMs: 60_000,
    probeForExistingInstall: false,
    defaultTarget: "cloud-managed",
  };
}

/**
 * Stock iOS builds are cloud-first at the picker, but the local/full-Bun path
 * starts an embedded backend in-process. Give restored local sessions the same
 * cold-start budget as desktop/ElizaOS so first-run PGlite setup is not treated
 * as a backend failure.
 */
export function createIosPolicy(): PlatformPolicy {
  return {
    supportsLocalRuntime: true,
    backendTimeoutMs: 180_000,
    agentReadyTimeoutMs: 300_000,
    probeForExistingInstall: false,
    defaultTarget: "cloud-managed",
  };
}

/**
 * Stock Android APKs can also host the bundled on-device agent when the user
 * picks Local. Keep the picker behaviour cloud-first for fresh installs, but
 * give restored local-agent sessions the same cold-start budget as ElizaOS.
 */
export function createAndroidPolicy(): PlatformPolicy {
  return {
    supportsLocalRuntime: true,
    backendTimeoutMs: 180_000,
    agentReadyTimeoutMs: 300_000,
    probeForExistingInstall: false,
    defaultTarget: "cloud-managed",
  };
}

/**
 * ElizaOS variant — the bundled APK runs the on-device agent on
 * loopback. Cold-boot timing observed on cuttlefish: ~30s PGlite
 * migration + ~30s agent registration + plugin load before
 * `/api/auth/status` is reachable. The vanilla `createMobilePolicy`
 * 15s `backendTimeoutMs` dead-ends the splash on a "Backend Timeout"
 * card before the agent finishes booting; bumping the budget to 3
 * minutes lets the natural poll loop pick it up.
 *
 * Also flips `supportsLocalRuntime` and `defaultTarget` because the
 * device IS the agent — there is no "cloud-managed" default to fall
 * back to on an ElizaOS-branded handset (or any white-label fork
 * thereof).
 */
export function createElizaOSPolicy(): PlatformPolicy {
  return {
    supportsLocalRuntime: true,
    backendTimeoutMs: 180_000,
    agentReadyTimeoutMs: 300_000,
    probeForExistingInstall: true,
    defaultTarget: "embedded-local",
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Map a restored server-target hint to a RuntimeTarget. */
export function connectionModeToTarget(
  runMode: string | undefined,
): RuntimeTarget {
  switch (runMode) {
    case "cloud":
      return "cloud-managed";
    case "remote":
      return "remote-backend";
    default:
      return "embedded-local";
  }
}

/** True when the coordinator is in a phase where the UI should show loading. */
export function isStartupLoading(state: StartupState): boolean {
  return (
    state.phase === "restoring-session" ||
    state.phase === "resolving-target" ||
    state.phase === "polling-backend" ||
    state.phase === "starting-runtime" ||
    state.phase === "hydrating"
  );
}

/** True when the coordinator has reached a terminal phase (ready or error). */
export function isStartupTerminal(state: StartupState): boolean {
  return state.phase === "ready" || state.phase === "error";
}

/**
 * Derive the legacy StartupPhase from the coordinator state.
 *
 * NOTE: pairing-required, onboarding-required, error, and hydrating all map
 * to "ready" — this looks counterintuitive but is correct because App.tsx's
 * coordinator gate (`startupCoordinator.phase !== "ready"`) catches these
 * phases BEFORE the legacy startupPhase/startupStatus rendering logic runs.
 * The legacy "ready" value is a no-op passthrough that never renders.
 */
export function toLegacyStartupPhase(
  state: StartupState,
): "starting-backend" | "initializing-agent" | "ready" {
  switch (state.phase) {
    case "restoring-session":
    case "resolving-target":
    case "polling-backend":
      return "starting-backend";
    case "starting-runtime":
      return "initializing-agent";
    default:
      return "ready";
  }
}
