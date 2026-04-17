import { useApp } from "../../state/useApp";
import { PermissionsOnboardingSection } from "../settings/PermissionsSection";
import { OnboardingStepHeader } from "./onboarding-step-chrome";

export function PermissionsStep() {
  const { handleOnboardingNext, handleOnboardingBack, t } = useApp();

  return (
    <>
      <OnboardingStepHeader eyebrow={t("onboarding.systemAccessTitle")} />
      <PermissionsOnboardingSection
        onContinue={(options) => void handleOnboardingNext(options)}
        onBack={() => handleOnboardingBack()}
      />
    </>
  );
}
