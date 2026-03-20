import {
  CLOUD_ONBOARDING_STEPS,
  CUSTOM_ONBOARDING_STEPS,
  useApp,
} from "@elizaos/app-core/state";
import { useBranding } from "../../config/branding";

const CUSTOM_STEP_IDS = new Set(CUSTOM_ONBOARDING_STEPS.map((s) => s.id));

export function OnboardingStepNav() {
  const { onboardingStep, t } = useApp();
  const branding = useBranding();

  const isCloudOnly = !!branding.cloudOnly;
  const isCustomFlow = CUSTOM_STEP_IDS.has(onboardingStep);

  const activeSteps = isCustomFlow
    ? CUSTOM_ONBOARDING_STEPS
    : isCloudOnly
      ? CLOUD_ONBOARDING_STEPS.filter((s) => s.id !== "welcome")
      : CLOUD_ONBOARDING_STEPS;

  const currentIndex = activeSteps.findIndex((s) => s.id === onboardingStep);

  return (
    <div className="onboarding-left">
      <div className={`onboarding-step-list step-${currentIndex}`}>
        {activeSteps.map((step, i) => {
          let state = "";
          if (i < currentIndex) state = "onboarding-step-item--done";
          else if (i === currentIndex) state = "onboarding-step-item--active";

          return (
            <div key={step.id} className={`onboarding-step-item ${state}`}>
              <div className="onboarding-step-dot" />
              <div className="onboarding-step-info">
                <span className="onboarding-step-name">{t(step.name)}</span>
                <span className="onboarding-step-sub">{t(step.subtitle)}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
