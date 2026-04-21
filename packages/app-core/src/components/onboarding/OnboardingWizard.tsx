import { useEffect } from "react";
import { normalizeLanguage } from "../../i18n";
import type { UiLanguage } from "../../i18n/messages";
import { applyUiTheme } from "../../state/persistence";
import { useApp } from "../../state/useApp";
import { LanguageDropdown } from "../shared/LanguageDropdown";
import { ConnectionStep } from "./ConnectionStep";
import { DeploymentStep } from "./DeploymentStep";
import { FeaturesStep } from "./FeaturesStep";
import { OnboardingPanel } from "./OnboardingPanel";
import { OnboardingStepNav } from "./OnboardingStepNav";

export function OnboardingWizard() {
  const { onboardingStep, uiLanguage, uiTheme, setState, t } = useApp();

  const setUiLanguage = (lang: UiLanguage) =>
    setState("uiLanguage", normalizeLanguage(lang));

  useEffect(() => {
    // Onboarding keeps a fixed light chrome; the main app owns theme switching.
    applyUiTheme("light");
    return () => {
      applyUiTheme(uiTheme);
    };
  }, [uiTheme]);

  useEffect(() => {
    const docEl = document.documentElement;
    const body = document.body;
    const prevDocOverflow = docEl.style.overflow;
    const prevDocOverscroll = docEl.style.overscrollBehavior;
    const prevBodyOverflow = body.style.overflow;
    const prevBodyOverscroll = body.style.overscrollBehavior;

    // Lock page-level scroll while onboarding is active; the panel handles its own scroll.
    docEl.style.overflow = "hidden";
    docEl.style.overscrollBehavior = "none";
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";

    return () => {
      docEl.style.overflow = prevDocOverflow;
      docEl.style.overscrollBehavior = prevDocOverscroll;
      body.style.overflow = prevBodyOverflow;
      body.style.overscrollBehavior = prevBodyOverscroll;
    };
  }, []);

  function renderStep() {
    switch (onboardingStep) {
      case "deployment":
        return <DeploymentStep />;
      case "providers":
        return <ConnectionStep />;
      case "features":
        return <FeaturesStep />;
      default:
        return null;
    }
  }

  return (
    <div className="onboarding-screen">
      <div
        aria-hidden="true"
        className="absolute inset-0 z-10 overflow-hidden pointer-events-none"
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.14),transparent_36%),linear-gradient(180deg,rgba(11,14,20,0.18),rgba(6,7,8,0.56))]" />
        <div className="absolute left-[-10%] top-[8%] h-[24rem] w-[24rem] rounded-full bg-[rgba(240,185,11,0.1)] blur-[110px]" />
        <div className="absolute bottom-[-12%] right-[-8%] h-[20rem] w-[20rem] rounded-full bg-[rgba(255,255,255,0.08)] blur-[120px]" />
      </div>

      <div
        data-testid="onboarding-ui-overlay"
        className="absolute inset-0 z-20 flex min-h-0 flex-col pointer-events-none"
      >
        <div
          style={{
            position: "absolute",
            top: "calc(var(--safe-area-top, 0px) + 0.5rem)",
            right: "calc(var(--safe-area-right, 0px) + 1rem)",
            zIndex: 50,
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
            pointerEvents: "auto",
          }}
        >
          <LanguageDropdown
            uiLanguage={uiLanguage}
            setUiLanguage={setUiLanguage}
            t={t}
            variant="companion"
            triggerClassName="!h-8 !min-h-0 !min-w-0 !rounded-lg !px-2.5 !text-xs leading-none"
          />
        </div>

        <div className="flex flex-1 items-center justify-center px-4 pb-[max(1.5rem,var(--safe-area-bottom,0px))] pt-[calc(var(--safe-area-top,0px)+3.75rem)] sm:px-6 md:px-8">
          <div className="flex w-full max-w-[48rem] flex-col items-center gap-4 pointer-events-auto">
            <OnboardingStepNav />
            <OnboardingPanel step={onboardingStep}>
              {renderStep()}
            </OnboardingPanel>
          </div>
        </div>
      </div>
    </div>
  );
}
