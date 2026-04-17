import { Button, Spinner } from "@elizaos/ui";

import { useEffect, useRef } from "react";
import { useBranding } from "../../config";
import { useApp } from "../../state/useApp";
import { openExternalUrl } from "../../utils";
import {
  OnboardingStepHeader,
  onboardingBodyTextShadowStyle,
  onboardingFooterClass,
  onboardingLinkActionClass,
  onboardingPrimaryActionClass,
  onboardingPrimaryActionTextShadowStyle,
  onboardingSecondaryActionClass,
  onboardingSecondaryActionTextShadowStyle,
  spawnOnboardingRipple,
} from "./onboarding-step-chrome";

const statusCardClass =
  "mx-auto mt-4 flex w-full max-w-[25rem] items-center justify-center gap-2 rounded-2xl border px-4 py-3 text-sm leading-relaxed shadow-[0_18px_50px_rgba(3,5,10,0.2)] backdrop-blur-sm";

const connectedCardClass = `${statusCardClass} border-[var(--ok-muted)] bg-[var(--ok-subtle)] text-ok`;

const busyCardClass = `${statusCardClass} border-[var(--onboarding-card-border)] bg-[var(--onboarding-card-bg)] text-[var(--onboarding-text-muted)]`;

const errorCardClass = `${statusCardClass} border-[color:color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color:color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger`;

export function CloudLoginStep() {
  const branding = useBranding();
  const {
    elizaCloudConnected,
    elizaCloudLoginBusy,
    elizaCloudLoginError,
    handleCloudLogin,
    handleOnboardingNext,
    handleOnboardingBack,
    t,
  } = useApp();

  const advancedRef = useRef(false);
  useEffect(() => {
    if (elizaCloudConnected && !advancedRef.current) {
      advancedRef.current = true;
      void handleOnboardingNext();
    }
  }, [elizaCloudConnected, handleOnboardingNext]);

  return (
    <>
      <OnboardingStepHeader
        eyebrow={t("onboarding.cloudLoginTitle")}
        description={t("onboarding.cloudLoginDesc")}
        descriptionClassName="mx-auto mt-1 max-w-[34ch] text-balance"
      />

      {elizaCloudConnected ? (
        <div
          className={connectedCardClass}
          role="status"
          style={onboardingBodyTextShadowStyle}
        >
          {t("onboarding.cloudLoginConnected")}
        </div>
      ) : elizaCloudLoginBusy ? (
        <div
          className={busyCardClass}
          role="status"
          aria-live="polite"
          style={onboardingBodyTextShadowStyle}
        >
          <Spinner size={16} className="text-current" />
          {t("onboarding.cloudLoginBusy")}
        </div>
      ) : (
        <>
          {elizaCloudLoginError ? (
            <>
              <div
                className={errorCardClass}
                role="alert"
                style={onboardingBodyTextShadowStyle}
              >
                {elizaCloudLoginError}
              </div>
              <Button
                variant="ghost"
                type="button"
                className={`${onboardingLinkActionClass} mx-auto mt-2`}
                onClick={() => openExternalUrl(branding.bugReportUrl)}
              >
                {t("onboarding.reportIssue")}
              </Button>
            </>
          ) : null}
          <Button
            className={`${onboardingPrimaryActionClass} mx-auto mt-4 flex w-full max-w-[25rem]`}
            style={onboardingPrimaryActionTextShadowStyle}
            onClick={(event) => {
              spawnOnboardingRipple(event.currentTarget, {
                x: event.clientX,
                y: event.clientY,
              });
              void handleCloudLogin();
            }}
            type="button"
          >
            {elizaCloudLoginError
              ? t("onboarding.cloudLoginRetry")
              : t("onboarding.cloudLoginBtn")}
          </Button>
        </>
      )}

      <div className={onboardingFooterClass}>
        <Button
          variant="ghost"
          className={onboardingSecondaryActionClass}
          style={onboardingSecondaryActionTextShadowStyle}
          onClick={() => handleOnboardingNext()}
          type="button"
        >
          {branding.cloudOnly
            ? t("onboarding.continueOffline")
            : t("onboarding.skip")}
        </Button>
      </div>
    </>
  );
}
