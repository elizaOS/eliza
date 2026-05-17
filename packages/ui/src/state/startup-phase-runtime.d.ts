/**
 * startup-phase-runtime.ts
 *
 * Side-effect logic for the "starting-runtime" startup phase.
 * Polls the agent status until running, then dispatches AGENT_RUNNING.
 */
import { type StartupErrorState } from "./internal";
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
export declare function runStartingRuntime(
  deps: StartingRuntimeDeps,
  dispatch: (event: StartupEvent) => void,
  effectRunId: number,
  effectRunRef: React.MutableRefObject<number>,
  cancelled: {
    current: boolean;
  },
  tidRef: {
    current: ReturnType<typeof setTimeout> | null;
  },
): Promise<void>;
//# sourceMappingURL=startup-phase-runtime.d.ts.map
