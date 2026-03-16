import { ONBOARDING_STEPS, useApp } from "@elizaos/app-core/state";

export function OnboardingStepNav() {
  const { onboardingStep, t } = useApp();

  const currentIndex = ONBOARDING_STEPS.findIndex(
    (s) => s.id === onboardingStep,
  );

  return (
    <div className="onboarding-left">
      <div className={`onboarding-step-list step-${currentIndex}`}>
        {ONBOARDING_STEPS.map((step, i) => {
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
