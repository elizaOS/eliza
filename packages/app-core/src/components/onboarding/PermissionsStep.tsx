import { PermissionsOnboardingSection } from "@elizaos/app-core/components";
import { useApp } from "@elizaos/app-core/state";

export function PermissionsStep() {
  const { handleOnboardingNext, t } = useApp();

  return (
    <>
      <div className="onboarding-section-title">
        {t("onboarding.systemAccessTitle")}
      </div>
      <div className="onboarding-divider">
        <div className="onboarding-divider-diamond" />
      </div>
      <PermissionsOnboardingSection
        onContinue={(options) => void handleOnboardingNext(options)}
      />
    </>
  );
}
