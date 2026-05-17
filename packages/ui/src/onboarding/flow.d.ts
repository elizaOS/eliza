/**
 * Onboarding wizard: pure flow resolution (no React, no API client).
 *
 * WHY this file exists:
 * - Step order used to be copy-pasted in AppContext (next + back) and again in the
 *   sidebar, which caused drift and subtle back/jump bugs.
 * - Keeping resolution pure here makes the graph testable without mounting React,
 *   and forces side effects (cloud login, finish, provider fill) to stay in
 *   AppContext where they already close over the right state.
 *
 * 3-step flow: deployment → providers → features
 * Deployment absorbs the old splash server chooser. Features enables connectors.
 *
 * See: docs/guides/onboarding-ui-flow.md
 * Tests: tests/flow.test.ts
 */
import type {
  FlaminaGuideTopic,
  OnboardingStep,
  OnboardingStepMeta,
} from "../state/types";
/** Linear step ids for the onboarding flow. */
export declare function getStepOrder(): OnboardingStep[];
export declare function getOnboardingStepIndex(step: OnboardingStep): number;
/**
 * Next step in the flow, or null at the end.
 * WHY null instead of throwing: callers treat "no next" as a no-op after
 * terminal advance paths (finish) have already run.
 */
export declare function resolveOnboardingNextStep(
  current: OnboardingStep,
): OnboardingStep | null;
/**
 * Previous step in the flow.
 * Returns null from the first step (deployment).
 */
export declare function resolveOnboardingPreviousStep(
  current: OnboardingStep,
): OnboardingStep | null;
/**
 * Sidebar jump is allowed only to a strictly earlier step.
 * WHY: forward jumps would skip handleOnboardingFinish, cloud login, and
 * in-step validation; repeated Back and sidebar back must stay equivalent.
 */
export declare function canRevertOnboardingTo(params: {
  current: OnboardingStep;
  target: OnboardingStep;
}): boolean;
/**
 * Rows shown in OnboardingStepNav.
 * Desktop, dev mode, and cloud-provisioned containers skip the deployment step.
 */
export declare function getOnboardingNavMetas(
  _currentStep: OnboardingStep,
  cloudOnly: boolean,
): OnboardingStepMeta[];
export declare function shouldSkipConnectionStepsForCloudProvisionedContainer(args: {
  currentStep: OnboardingStep;
  cloudProvisionedContainer: boolean;
}): boolean;
/**
 * Whether to skip the features step entirely.
 * The current wizard always shows features so local capabilities such as
 * Browser and Wallet can be chosen for local, remote, and cloud agents.
 */
export declare function shouldSkipFeaturesStep(args: {
  onboardingServerTarget: string;
}): boolean;
export declare function shouldUseCloudOnboardingFastTrack(args: {
  cloudProvisionedContainer: boolean;
  elizaCloudConnected: boolean;
  onboardingRunMode: "local" | "cloud" | "";
  onboardingProvider: string;
}): boolean;
/** Flamina companion guide topic for advanced onboarding mode, or null. */
export declare function getFlaminaTopicForOnboardingStep(
  step: OnboardingStep,
): FlaminaGuideTopic | null;
//# sourceMappingURL=flow.d.ts.map
