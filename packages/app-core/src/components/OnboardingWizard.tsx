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
import { useEffect, useState } from "react";
import { useBranding } from "../config/branding";
import { COMPANION_ENABLED } from "../navigation";
import { VrmStage } from "./companion/VrmStage";
import { ActivateStep } from "./onboarding/ActivateStep";
import { ConnectionStep } from "./onboarding/ConnectionStep";
import { IdentityStep } from "./onboarding/IdentityStep";
import { OnboardingPanel } from "./onboarding/OnboardingPanel";
import { OnboardingStepNav } from "./onboarding/OnboardingStepNav";
import { PermissionsStep } from "./onboarding/PermissionsStep";
import { RpcStep } from "./onboarding/RpcStep";

const FORCE_VRM =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("test_force_vrm") === "1";

const DISABLE_ONBOARDING_VRM =
  !FORCE_VRM &&
  (String(import.meta.env.VITE_E2E_DISABLE_VRM ?? "").toLowerCase() === "true" ||
    String(import.meta.env.VITE_E2E_DISABLE_VRM ?? "") === "1");

export function OnboardingWizard() {
  const branding = useBranding();
  const isEliza = branding.appName === "Eliza";
  const disableVrm = !FORCE_VRM && (DISABLE_ONBOARDING_VRM || isEliza || !COMPANION_ENABLED);
  const [revealStarted, setRevealStarted] = useState(disableVrm);

  const {
    onboardingStep,
    selectedVrmIndex,
    customVrmUrl,
    uiLanguage,
    uiTheme,
    setState,
    handleOnboardingNext,
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

  useEffect(() => {
    // Onboarding keeps a fixed "light" chrome; companion mode owns day/night scenes.
    applyUiTheme("light");
    return () => {
      applyUiTheme(uiTheme);
    };
  }, [uiTheme]);

  // Auto-advance past the wakeUp splash once the VRM reveal animation starts,
  // or after a 4-second timeout to prevent getting stuck when VRM fails to load.
  useEffect(() => {
    if (onboardingStep !== "wakeUp") return;
    if (revealStarted) {
      handleOnboardingNext();
      return;
    }
    const timer = setTimeout(() => {
      setRevealStarted(true);
    }, 4000);
    return () => clearTimeout(timer);
  }, [onboardingStep, revealStarted, handleOnboardingNext]);

  function renderStep() {
    switch (onboardingStep) {
      case "identity":
        // Rendered outside the panel in OnboardingWizard JSX
        return null;
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

      {/* Keep browser E2E runs lightweight and deterministic by skipping VRM boot. */}
      {disableVrm ? (
        <div
          aria-hidden="true"
          className="absolute inset-0 z-10 pointer-events-none"
          style={{
            background:
              "radial-gradient(circle at 50% 25%, rgba(255,255,255,0.16), transparent 34%), linear-gradient(180deg, rgba(17,17,17,0.08), rgba(10,10,10,0.36))",
          }}
        />
      ) : (
        <VrmStage
          vrmPath={vrmPath}
          worldUrl={worldUrl}
          fallbackPreviewUrl={fallbackPreview}
          cameraProfile="companion_close"
          initialCompanionZoomNormalized={1}
          onRevealStart={() => setRevealStarted(true)}
          t={t}
        />
      )}

      <div
        data-testid="onboarding-ui-overlay"
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: revealStarted ? "auto" : "none",
          opacity: revealStarted ? 1 : 0,
          transition: "opacity 1.2s ease-in-out",
          zIndex: 40,
        }}
      >
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

        {/* ── Standard overlaid UI — step nav + content panel ── */}
        <div className="onboarding-ui-overlay">
          <OnboardingStepNav />
          {onboardingStep === "identity" ? (
            /* Identity step renders full-width at the bottom — no glass panel */
            <div className="ob-identity-overlay">
              <IdentityStep />
            </div>
          ) : (
            <OnboardingPanel step={onboardingStep}>
              {renderStep()}
            </OnboardingPanel>
          )}
        </div>
      </div>
    </div>
  );
}
