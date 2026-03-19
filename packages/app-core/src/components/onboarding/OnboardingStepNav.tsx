import { ONBOARDING_STEPS, useApp } from "@elizaos/app-core/state";
import { useBranding } from "../../config/branding";

export function OnboardingStepNav() {
  const { onboardingStep, t } = useApp();
  const branding = useBranding();

  const isEliza = branding.appName === "Eliza";
  const isCloudOnly = !!branding.cloudOnly;
  const activeSteps = isEliza
    ? ONBOARDING_STEPS.filter(
        (s) => s.id === "connection" || s.id === "activate",
      )
    : isCloudOnly
      ? ONBOARDING_STEPS.filter((s) => s.id !== "wakeUp")
      : ONBOARDING_STEPS;

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
