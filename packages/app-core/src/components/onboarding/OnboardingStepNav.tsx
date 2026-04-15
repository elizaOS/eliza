import { OnboardingStepNav as PureOnboardingStepNav } from "@elizaos/ui";
import { useApp } from "@elizaos/app-core/state";
import { useBranding } from "../../config/branding";
import { getOnboardingNavMetas } from "../../onboarding/flow";
import * as React from "react";

export function OnboardingStepNav() {
  const { onboardingStep, handleOnboardingJumpToStep, t } = useApp();
  const branding = useBranding();

  const isCloudOnly = Boolean(branding.cloudOnly);
  const onboardingNavMetas = getOnboardingNavMetas(onboardingStep, isCloudOnly);

  return (
    <PureOnboardingStepNav
      currentStep={onboardingStep}
      onboardingNavMetas={onboardingNavMetas}
      handleOnboardingJumpToStep={handleOnboardingJumpToStep}
      t={t}
    />
  );
}

