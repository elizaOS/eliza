/**
 * startup-phase-poll.ts
 *
 * Side-effect logic for the "polling-backend" startup phase.
 * Polls the backend until it responds, then dispatches BACKEND_REACHED
 * or an appropriate error/auth event.
 */
import type { OnboardingOptions } from "../api";
import { scanProviderCredentials } from "../bridge";
import type { UiLanguage } from "../i18n";
import type { OnboardingServerTarget } from "../onboarding/server-target";
import { type StartupErrorState } from "./internal";
import type { PlatformPolicy, StartupEvent } from "./startup-coordinator";
import type { RestoringSessionCtx } from "./startup-phase-restore";
import type { OnboardingStep } from "./types";
export interface PollingBackendDeps {
  setStartupError: (v: StartupErrorState | null) => void;
  setAuthRequired: (v: boolean) => void;
  setOnboardingComplete: (v: boolean) => void;
  setOnboardingLoading: (v: boolean) => void;
  setOnboardingOptions: (v: OnboardingOptions) => void;
  setOnboardingStep: (v: OnboardingStep) => void;
  setOnboardingServerTarget: (v: OnboardingServerTarget) => void;
  setOnboardingCloudApiKey: (v: string) => void;
  setOnboardingProvider: (v: string) => void;
  setOnboardingVoiceProvider: (v: string) => void;
  setOnboardingApiKey: (v: string) => void;
  setOnboardingPrimaryModel: (v: string) => void;
  setOnboardingOpenRouterModel: (v: string) => void;
  setOnboardingRemoteConnected: (v: boolean) => void;
  setOnboardingRemoteApiBase: (v: string) => void;
  setOnboardingRemoteToken: (v: string) => void;
  setOnboardingSmallModel: (v: string) => void;
  setOnboardingLargeModel: (v: string) => void;
  setOnboardingCloudProvisionedContainer: (v: boolean) => void;
  setPairingEnabled: (v: boolean) => void;
  setPairingExpiresAt: (v: number | null) => void;
  applyDetectedProviders: (
    detected: Awaited<ReturnType<typeof scanProviderCredentials>>,
  ) => void;
  onboardingCompletionCommittedRef: React.MutableRefObject<boolean>;
  uiLanguage: UiLanguage;
}
/**
 * Runs the polling-backend phase.
 * Polls /auth/status and /onboarding/status until the backend is reachable
 * and onboarding state is determined.
 *
 * @param deps - Coordinator dependency bag
 * @param dispatch - startupReducer dispatch
 * @param policy - Platform policy (timeout etc.)
 * @param ctx - Session context populated by the restoring-session phase
 * @param effectRunId - The run ID of the calling effect (for stale-close guard)
 * @param effectRunRef - Shared ref tracking the latest run ID
 * @param cancelled - Ref-flag set true by the cleanup function
 * @param tidRef - Mutable ref for the pending setTimeout handle (for cleanup)
 */
export declare function runPollingBackend(
  deps: PollingBackendDeps,
  dispatch: (event: StartupEvent) => void,
  policy: PlatformPolicy,
  ctx: RestoringSessionCtx | null,
  effectRunId: number,
  effectRunRef: React.MutableRefObject<number>,
  cancelled: {
    current: boolean;
  },
  tidRef: {
    current: ReturnType<typeof setTimeout> | null;
  },
): Promise<void>;
//# sourceMappingURL=startup-phase-poll.d.ts.map
