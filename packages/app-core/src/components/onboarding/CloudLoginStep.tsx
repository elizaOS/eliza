import { useApp } from "@elizaos/app-core/state";
import { useEffect, useRef } from "react";

export function CloudLoginStep() {
  const {
    onboardingStep,
    elizaCloudConnected,
    elizaCloudLoginBusy,
    elizaCloudLoginError,
    handleCloudLogin,
    handleOnboardingNext,
    handleOnboardingBack,
    t,
  } = useApp();

  // Auto-advance when cloud login succeeds — guarded to only fire once
  // and only while we're still on the cloudLogin step.
  const advancedRef = useRef(false);
  useEffect(() => {
    if (
      elizaCloudConnected &&
      onboardingStep === "cloudLogin" &&
      !advancedRef.current
    ) {
      advancedRef.current = true;
      void handleOnboardingNext();
    }
  }, [elizaCloudConnected, onboardingStep, handleOnboardingNext]);

  return (
    <>
      <div className="onboarding-section-title">
        {t("onboarding.cloudLoginTitle")}
      </div>
      <div className="onboarding-divider">
        <div className="onboarding-divider-diamond" />
      </div>
      <p className="onboarding-desc">{t("onboarding.cloudLoginDesc")}</p>

      {elizaCloudConnected ? (
        <p className="onboarding-desc text-[var(--ok)]">
          {t("onboarding.cloudLoginConnected")}
        </p>
      ) : elizaCloudLoginBusy ? (
        <div className="flex items-center gap-2 onboarding-desc">
          <span className="animate-spin inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full" />
          {t("onboarding.cloudLoginBusy")}
        </div>
      ) : (
        <>
          {elizaCloudLoginError && (
            <p className="onboarding-desc text-[var(--danger)] !mb-2">
              {elizaCloudLoginError}
            </p>
          )}
          <button
            className="onboarding-confirm-btn"
            onClick={() => void handleCloudLogin()}
            type="button"
          >
            {elizaCloudLoginError
              ? t("onboarding.cloudLoginRetry")
              : t("onboarding.cloudLoginBtn")}
          </button>
        </>
      )}

      <div className="onboarding-panel-footer">
        <button
          className="onboarding-back-link"
          onClick={() => handleOnboardingBack()}
          type="button"
        >
          {t("onboarding.back")}
        </button>
      </div>
    </>
  );
}
