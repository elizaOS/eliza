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

import { canRunLocal } from "../platform/init";
import type {
  FlaminaGuideTopic,
  OnboardingStep,
  OnboardingStepMeta,
} from "../state/types";
import { ONBOARDING_STEPS } from "../state/types";

/** Linear step ids for the onboarding flow. */
export function getStepOrder(): OnboardingStep[] {
  return ONBOARDING_STEPS.map((s) => s.id);
}

export function getOnboardingStepIndex(step: OnboardingStep): number {
  return getStepOrder().indexOf(step);
}

/**
 * Next step in the flow, or null at the end.
 * WHY null instead of throwing: callers treat "no next" as a no-op after
 * terminal advance paths (finish) have already run.
 */
export function resolveOnboardingNextStep(
  current: OnboardingStep,
): OnboardingStep | null {
  const order = getStepOrder();
  const i = order.indexOf(current);
  if (i < 0 || i >= order.length - 1) return null;
  return order[i + 1] ?? null;
}

/**
 * Previous step in the flow.
 * Returns null from the first step (deployment).
 */
export function resolveOnboardingPreviousStep(
  current: OnboardingStep,
): OnboardingStep | null {
  const order = getStepOrder();
  const i = order.indexOf(current);
  if (i > 0) return order[i - 1] ?? null;
  return null;
}

/**
 * Sidebar jump is allowed only to a strictly earlier step.
 * WHY: forward jumps would skip handleOnboardingFinish, cloud login, and
 * in-step validation; repeated Back and sidebar back must stay equivalent.
 */
export function canRevertOnboardingTo(params: {
  current: OnboardingStep;
  target: OnboardingStep;
}): boolean {
  const curIdx = getOnboardingStepIndex(params.current);
  const tgtIdx = getOnboardingStepIndex(params.target);
  return tgtIdx >= 0 && curIdx >= 0 && tgtIdx < curIdx;
}

/**
 * Rows shown in OnboardingStepNav.
 * Desktop, dev mode, and cloud-provisioned containers skip the deployment step.
 */
export function getOnboardingNavMetas(
  _currentStep: OnboardingStep,
  cloudOnly: boolean,
): OnboardingStepMeta[] {
  if (cloudOnly || canRunLocal()) {
    return ONBOARDING_STEPS.filter((s) => s.id !== "deployment");
  }
  return [...ONBOARDING_STEPS];
}

export function shouldSkipConnectionStepsForCloudProvisionedContainer(args: {
  currentStep: OnboardingStep;
  cloudProvisionedContainer: boolean;
}): boolean {
  return args.cloudProvisionedContainer && args.currentStep === "deployment";
}

/**
 * Whether to skip the features step entirely.
 * The current wizard always shows features so local capabilities such as
 * Browser and Wallet can be chosen for local, remote, and cloud agents.
 */
export function shouldSkipFeaturesStep(args: {
  onboardingServerTarget: string;
}): boolean {
  void args;
  return false;
}

export function shouldUseCloudOnboardingFastTrack(args: {
  cloudProvisionedContainer: boolean;
  elizaCloudConnected: boolean;
  onboardingRunMode: "local" | "cloud" | "";
  onboardingProvider: string;
}): boolean {
  if (args.cloudProvisionedContainer) {
    return true;
  }

  return (
    args.elizaCloudConnected &&
    !(
      args.onboardingRunMode === "local" &&
      args.onboardingProvider &&
      args.onboardingProvider !== "elizacloud"
    )
  );
}

/** Flamina companion guide topic for advanced onboarding mode, or null. */
export function getFlaminaTopicForOnboardingStep(
  step: OnboardingStep,
): FlaminaGuideTopic | null {
  switch (step) {
    case "providers":
      return "provider";
    case "features":
      return "features";
    default:
      return null;
  }
}
