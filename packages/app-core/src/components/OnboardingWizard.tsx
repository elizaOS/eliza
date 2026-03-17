import { LanguageDropdown } from "@elizaos/app-core/components";
import type { UiLanguage } from "@elizaos/app-core/i18n";
import { normalizeLanguage } from "@elizaos/app-core/i18n";
import {
  applyUiTheme,
  getVrmPreviewUrl,
  getVrmUrl,
  useApp,
} from "@elizaos/app-core/state";
import { resolveAppAssetUrl } from "@elizaos/app-core/utils";
import { useEffect } from "react";
import { VrmStage } from "./companion/VrmStage";
import { ActivateStep } from "./onboarding/ActivateStep";
import { ConnectionStep } from "./onboarding/ConnectionStep";
import { IdentityStep } from "./onboarding/IdentityStep";
import { OnboardingPanel } from "./onboarding/OnboardingPanel";
import { OnboardingStepNav } from "./onboarding/OnboardingStepNav";
import { PermissionsStep } from "./onboarding/PermissionsStep";
import { RpcStep } from "./onboarding/RpcStep";

export function OnboardingWizard() {
  const {
    onboardingStep,
    selectedVrmIndex,
    customVrmUrl,
    uiLanguage,
    uiTheme,
    setState,
    t,
  } = useApp();

  const setUiLanguage = (lang: UiLanguage) =>
    setState("uiLanguage", normalizeLanguage(lang));

  // Use same VRM resolution logic as CompanionView for character unification
  const safeSelectedVrmIndex = selectedVrmIndex > 0 ? selectedVrmIndex : 1;
  const vrmPath =
    selectedVrmIndex === 0 && customVrmUrl
      ? customVrmUrl
      : getVrmUrl(safeSelectedVrmIndex);
  const fallbackPreview =
    selectedVrmIndex > 0
      ? getVrmPreviewUrl(safeSelectedVrmIndex)
      : getVrmPreviewUrl(1);
  const worldUrl = resolveAppAssetUrl("worlds/companion-day.spz");

  const isCharacterSelect = onboardingStep === "identity";

  useEffect(() => {
    // Onboarding keeps a fixed "light" chrome; companion mode owns day/night scenes.
    applyUiTheme("light");
    return () => {
      applyUiTheme(uiTheme);
    };
  }, [uiTheme]);

  function renderStep() {
    switch (onboardingStep) {
      case "identity":
        return <IdentityStep />;
      case "connection":
        return <ConnectionStep />;
      case "rpc":
        return <RpcStep />;
      case "senses":
        return <PermissionsStep />;
      case "activate":
        return <ActivateStep />;
      default:
        return null;
    }
  }

  return (
    <div className="onboarding-screen">
      {/* Full-screen VRM background — same as CompanionView */}
      <div className="onboarding-bg" />
      <div className="onboarding-bg-overlay" />

      {/* VRM character — fills viewport, zoomed in like companion view */}
      <VrmStage
        vrmPath={vrmPath}
        worldUrl={worldUrl}
        fallbackPreviewUrl={fallbackPreview}
        cameraProfile="companion_close"
        initialCompanionZoomNormalized={1}
        t={t}
      />

      {/* Corner decorations */}
      <svg
        className="onboarding-corner onboarding-corner--tl"
        viewBox="0 0 36 36"
        fill="none"
        stroke="rgba(240,185,11,0.18)"
        strokeWidth="1"
        aria-hidden="true"
      >
        <path d="M0 18 L0 0 L18 0" />
        <circle
          cx="0"
          cy="0"
          r="2"
          fill="rgba(240,185,11,0.25)"
          stroke="none"
        />
      </svg>
      <svg
        className="onboarding-corner onboarding-corner--tr"
        viewBox="0 0 36 36"
        fill="none"
        stroke="rgba(240,185,11,0.18)"
        strokeWidth="1"
        aria-hidden="true"
      >
        <path d="M0 18 L0 0 L18 0" />
        <circle
          cx="0"
          cy="0"
          r="2"
          fill="rgba(240,185,11,0.25)"
          stroke="none"
        />
      </svg>
      <svg
        className="onboarding-corner onboarding-corner--bl"
        viewBox="0 0 36 36"
        fill="none"
        stroke="rgba(240,185,11,0.18)"
        strokeWidth="1"
        aria-hidden="true"
      >
        <path d="M0 18 L0 0 L18 0" />
        <circle
          cx="0"
          cy="0"
          r="2"
          fill="rgba(240,185,11,0.25)"
          stroke="none"
        />
      </svg>
      <svg
        className="onboarding-corner onboarding-corner--br"
        viewBox="0 0 36 36"
        fill="none"
        stroke="rgba(240,185,11,0.18)"
        strokeWidth="1"
        aria-hidden="true"
      >
        <path d="M0 18 L0 0 L18 0" />
        <circle
          cx="0"
          cy="0"
          r="2"
          fill="rgba(240,185,11,0.25)"
          stroke="none"
        />
      </svg>

      {/* Language selector — top right */}
      <div
        style={{
          position: "absolute",
          top: "1rem",
          right: "1rem",
          zIndex: 50,
          display: "flex",
          gap: "0.5rem",
          alignItems: "center",
        }}
      >
        <LanguageDropdown
          uiLanguage={uiLanguage}
          setUiLanguage={setUiLanguage}
          t={t}
          variant="companion"
        />
      </div>

      {isCharacterSelect ? (
        /* ── Full-screen centered character select ── */
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 40,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "2rem",
          }}
        >
          <IdentityStep />
        </div>
      ) : (
        /* ── Standard overlaid UI — step nav + content panel ── */
        <div className="onboarding-ui-overlay">
          <OnboardingStepNav />
          <OnboardingPanel step={onboardingStep}>
            {renderStep()}
          </OnboardingPanel>
        </div>
      )}
    </div>
  );
}
