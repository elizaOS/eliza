import { Button, Input } from "@elizaos/ui";
import { appNameInterpolationVars, useBranding } from "../../../config";
import type {
  ConnectionEffect,
  ConnectionEvent,
} from "../../../onboarding/connection-flow";
import { useApp } from "../../../state";
import {
  OnboardingField,
  OnboardingStatusBanner,
  onboardingDetailStackClassName,
  onboardingInputClassName,
} from "../onboarding-form-primitives";
import {
  OnboardingSecondaryActionButton,
  OnboardingStepHeader,
  onboardingFooterClass,
  onboardingPrimaryActionClass,
  onboardingPrimaryActionTextShadowStyle,
  spawnOnboardingRipple,
} from "../onboarding-step-chrome";

export function ConnectionRemoteBackendScreen({
  dispatch,
  onTransitionEffect,
}: {
  dispatch: (event: ConnectionEvent) => void;
  onTransitionEffect: (effect: ConnectionEffect) => void;
}) {
  const branding = useBranding();
  const {
    t,
    onboardingRemoteApiBase,
    onboardingRemoteToken,
    onboardingRemoteConnecting,
    onboardingRemoteError,
    onboardingRemoteConnected,
    handleOnboardingRemoteConnect,
    setState,
  } = useApp();

  return (
    <>
      <OnboardingStepHeader
        eyebrow={t(
          "onboarding.remoteTitle",
          appNameInterpolationVars(branding),
        )}
      />
      <div className={`${onboardingDetailStackClassName} mt-1`}>
        <OnboardingField
          controlId="remote-api-base"
          label={t("onboarding.remoteAddress")}
        >
          {({ describedBy, invalid }) => (
            <Input
              id="remote-api-base"
              type="text"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              className={`${onboardingInputClassName} text-center`}
              placeholder={t("onboarding.remoteAddressPlaceholder")}
              value={onboardingRemoteApiBase}
              onChange={(e) =>
                setState("onboardingRemoteApiBase", e.target.value)
              }
            />
          )}
        </OnboardingField>

        <OnboardingField
          controlId="remote-api-token"
          label={t("onboarding.remoteAccessKey")}
        >
          {({ describedBy, invalid }) => (
            <Input
              id="remote-api-token"
              type="password"
              aria-describedby={describedBy}
              aria-invalid={invalid}
              className={`${onboardingInputClassName} text-center`}
              placeholder={t("onboarding.remoteAccessKeyPlaceholder")}
              value={onboardingRemoteToken}
              onChange={(e) =>
                setState("onboardingRemoteToken", e.target.value)
              }
            />
          )}
        </OnboardingField>

        {onboardingRemoteError ? (
          <OnboardingStatusBanner tone="error" live="assertive">
            {onboardingRemoteError}
          </OnboardingStatusBanner>
        ) : null}
      </div>
      <div className={onboardingFooterClass}>
        <OnboardingSecondaryActionButton
          onClick={() => {
            if (onboardingRemoteConnected) {
              onTransitionEffect("useLocalBackend");
              return;
            }
            dispatch({ type: "backRemoteOrGrid" });
          }}
          type="button"
        >
          {t("onboarding.back")}
        </OnboardingSecondaryActionButton>
        <Button
          className={onboardingPrimaryActionClass}
          style={onboardingPrimaryActionTextShadowStyle}
          onClick={(e) => {
            spawnOnboardingRipple(e.currentTarget, {
              x: e.clientX,
              y: e.clientY,
            });
            void handleOnboardingRemoteConnect();
          }}
          disabled={onboardingRemoteConnecting}
          type="button"
        >
          {onboardingRemoteConnecting
            ? t("onboarding.connecting")
            : t("onboarding.remoteConnect")}
        </Button>
      </div>
    </>
  );
}
