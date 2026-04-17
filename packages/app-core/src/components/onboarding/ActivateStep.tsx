import { Button } from "@elizaos/ui";

import { useBranding } from "../../config/branding";
import { useApp } from "../../state/useApp";
import {
  OnboardingSecondaryActionButton,
  OnboardingStepHeader,
  onboardingFooterClass,
  onboardingPrimaryActionClass,
  onboardingPrimaryActionTextShadowStyle,
  spawnOnboardingRipple,
} from "./onboarding-step-chrome";

export function ActivateStep() {
  const branding = useBranding();
  const { onboardingName, handleOnboardingNext, handleOnboardingBack, t } =
    useApp();

  return (
    <>
      <OnboardingStepHeader
        eyebrow={t("onboarding.readyTitle")}
        title={t("onboarding.companionReady", {
          name: onboardingName || branding.appName,
        })}
        description={t("onboarding.allConfigured")}
      />
      <div className={onboardingFooterClass}>
        <OnboardingSecondaryActionButton
          onClick={() => handleOnboardingBack()}
          type="button"
        >
          {t("onboarding.back")}
        </OnboardingSecondaryActionButton>
        <Button
          className={onboardingPrimaryActionClass}
          data-testid="onboarding-activate-enter"
          style={onboardingPrimaryActionTextShadowStyle}
          onClick={(event?: React.MouseEvent<HTMLButtonElement>) => {
            spawnOnboardingRipple(
              event?.currentTarget ?? null,
              event
                ? {
                    x: event.clientX,
                    y: event.clientY,
                  }
                : undefined,
            );
            handleOnboardingNext();
          }}
          type="button"
        >
          {t("onboarding.enter")}
        </Button>
      </div>
    </>
  );
}
