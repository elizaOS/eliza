import { useBranding } from "@elizaos/app-core/config";
import { useApp } from "@elizaos/app-core/state";

export function WelcomeStep() {
  const branding = useBranding();
  const { handleOnboardingNext, setState, t } = useApp();

  const handleCustomSetup = () => {
    // Jump directly to the first custom flow step
    setState("onboardingStep", "identity");
  };

  return (
    <>
      <div className="onboarding-section-title">
        {t("onboarding.welcomeTitle", { name: branding.appName })}
      </div>
      <div className="onboarding-divider">
        <div className="onboarding-divider-diamond" />
      </div>
      <p className="onboarding-desc">{t("onboarding.welcomeDesc")}</p>
      <div className="onboarding-panel-footer">
        <span />
        <button
          className="onboarding-confirm-btn"
          onClick={() => void handleOnboardingNext()}
          type="button"
        >
          {t("onboarding.getStarted")}
        </button>
      </div>
      <div
        style={{
          position: "absolute",
          bottom: "12px",
          right: "16px",
        }}
      >
        <button
          type="button"
          onClick={handleCustomSetup}
          style={{
            background: "none",
            border: "none",
            color: "rgba(255, 255, 255, 0.3)",
            fontSize: "10px",
            letterSpacing: "0.08em",
            cursor: "pointer",
            padding: 0,
            fontFamily: "inherit",
            transition: "color 0.2s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "rgba(240, 185, 11, 0.6)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "rgba(255, 255, 255, 0.3)";
          }}
        >
          {t("onboarding.customSetup") || "custom"}
        </button>
      </div>
    </>
  );
}
