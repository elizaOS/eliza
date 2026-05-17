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
import { type PlatformPolicy, type RuntimeTarget, type StartupEvent, type StartupState } from "./startup-coordinator";
import { type HydratingDeps, type ReadyPhaseDeps } from "./startup-phase-hydrate";
import { type PollingBackendDeps } from "./startup-phase-poll";
import { type RestoringSessionDeps } from "./startup-phase-restore";
import { type StartingRuntimeDeps } from "./startup-phase-runtime";
export type StartupCoordinatorDeps = RestoringSessionDeps & PollingBackendDeps & StartingRuntimeDeps & HydratingDeps & ReadyPhaseDeps & {
    /** Legacy lifecycle setter — driven by the coordinator sync effect. */
    setStartupPhase: (v: "starting-backend" | "initializing-agent" | "ready") => void;
};
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
export declare function useStartupCoordinator(deps?: StartupCoordinatorDeps): StartupCoordinatorHandle;
//# sourceMappingURL=useStartupCoordinator.d.ts.map