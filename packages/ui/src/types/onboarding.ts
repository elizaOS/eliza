export type OnboardingStep = "deployment" | "providers" | "features";

export interface OnboardingStepMeta {
  id: OnboardingStep;
  name: string;
  subtitle: string;
}

export const ONBOARDING_STEPS: OnboardingStepMeta[] = [
  {
    id: "deployment",
    name: "onboarding.stepName.deployment",
    subtitle: "onboarding.stepSub.deployment",
  },
  {
    id: "providers",
    name: "onboarding.stepName.providers",
    subtitle: "onboarding.stepSub.providers",
  },
  {
    id: "features",
    name: "onboarding.stepName.features",
    subtitle: "onboarding.stepSub.features",
  },
];
