import { type OnboardingFlowState } from "./state-machine";
export interface PersistedOnboardingHook {
  state: OnboardingFlowState;
  setState: (next: OnboardingFlowState) => void;
  reset: () => void;
}
export declare function useOnboardingPersisted(): PersistedOnboardingHook;
export declare const ONBOARDING_STORAGE_KEY = "eliza.onboarding.v2";
//# sourceMappingURL=state-persistence.d.ts.map
