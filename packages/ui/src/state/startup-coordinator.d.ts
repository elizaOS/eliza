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
export type RuntimeTarget = "embedded-local" | "remote-backend" | "cloud-managed";
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
export type StartupState = {
    phase: "splash";
    loaded: boolean;
} | {
    phase: "restoring-session";
} | {
    phase: "resolving-target";
    target: RuntimeTarget;
} | {
    phase: "polling-backend";
    target: RuntimeTarget;
    attempts: number;
} | {
    phase: "pairing-required";
} | {
    phase: "onboarding-required";
    /** true = server reachable, fetch options from it. false = first-run, use static options. */
    serverReachable: boolean;
} | {
    phase: "starting-runtime";
    attempts: number;
} | {
    phase: "hydrating";
} | {
    phase: "ready";
} | {
    phase: "error";
    reason: StartupErrorReason;
    message: string;
    timedOut: boolean;
};
export type { StartupErrorReason };
export type StartupPhaseValue = StartupState["phase"];
export type StartupEvent = {
    type: "SESSION_RESTORED";
    target: RuntimeTarget;
} | {
    type: "NO_SESSION";
    hadPriorOnboarding: boolean;
} | {
    type: "EXISTING_INSTALL_DETECTED";
    target: RuntimeTarget;
} | {
    type: "BACKEND_REACHED";
    onboardingComplete: boolean;
} | {
    type: "BACKEND_AUTH_REQUIRED";
} | {
    type: "BACKEND_NOT_FOUND";
} | {
    type: "BACKEND_TIMEOUT";
} | {
    type: "BACKEND_POLL_RETRY";
} | {
    type: "ONBOARDING_OPTIONS_LOADED";
} | {
    type: "ONBOARDING_COMPLETE";
} | {
    type: "AGENT_RUNNING";
} | {
    type: "AGENT_STARTING";
} | {
    type: "AGENT_ERROR";
    message: string;
} | {
    type: "AGENT_TIMEOUT";
} | {
    type: "AGENT_POLL_RETRY";
} | {
    type: "HYDRATION_COMPLETE";
} | {
    type: "RETRY";
} | {
    type: "RESET";
} | {
    type: "PAIRING_SUCCESS";
} | {
    type: "SPLASH_CONTINUE";
} | {
    type: "SPLASH_LOADED";
} | {
    type: "SPLASH_CLOUD_SKIP";
} | {
    type: "SWITCH_AGENT";
    target: RuntimeTarget;
};
export declare function startupReducer(state: StartupState, event: StartupEvent): StartupState;
export declare const INITIAL_STARTUP_STATE: StartupState;
export declare function createDesktopPolicy(): PlatformPolicy;
export declare function createWebPolicy(): PlatformPolicy;
export declare function createMobilePolicy(): PlatformPolicy;
/**
 * Stock iOS builds are cloud-first at the picker, but the local/full-Bun path
 * starts an embedded backend in-process. Give restored local sessions the same
 * cold-start budget as desktop/ElizaOS so first-run PGlite setup is not treated
 * as a backend failure.
 */
export declare function createIosPolicy(): PlatformPolicy;
/**
 * Stock Android APKs can also host the bundled on-device agent when the user
 * picks Local. Keep the picker behaviour cloud-first for fresh installs, but
 * give restored local-agent sessions the same cold-start budget as ElizaOS.
 */
export declare function createAndroidPolicy(): PlatformPolicy;
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
export declare function createElizaOSPolicy(): PlatformPolicy;
/** Map a restored server-target hint to a RuntimeTarget. */
export declare function connectionModeToTarget(runMode: string | undefined): RuntimeTarget;
/** True when the coordinator is in a phase where the UI should show loading. */
export declare function isStartupLoading(state: StartupState): boolean;
/** True when the coordinator has reached a terminal phase (ready or error). */
export declare function isStartupTerminal(state: StartupState): boolean;
/**
 * Derive the legacy StartupPhase from the coordinator state.
 *
 * NOTE: pairing-required, onboarding-required, error, and hydrating all map
 * to "ready" — this looks counterintuitive but is correct because App.tsx's
 * coordinator gate (`startupCoordinator.phase !== "ready"`) catches these
 * phases BEFORE the legacy startupPhase/startupStatus rendering logic runs.
 * The legacy "ready" value is a no-op passthrough that never renders.
 */
export declare function toLegacyStartupPhase(state: StartupState): "starting-backend" | "initializing-agent" | "ready";
//# sourceMappingURL=startup-coordinator.d.ts.map