import { Button, Input } from "@elizaos/ui";
import { useApp } from "../../state/useApp";
import {
  OnboardingField,
  OnboardingStatusBanner,
  onboardingCenteredStackClassName,
  onboardingDetailStackClassName,
  onboardingInfoPanelClassName,
  onboardingInputClassName,
} from "./onboarding-form-primitives";
import {
  OnboardingStepHeader,
  onboardingFooterClass,
  onboardingPrimaryActionClass,
  onboardingPrimaryActionTextShadowStyle,
  onboardingSecondaryActionClass,
  onboardingSecondaryActionTextShadowStyle,
  spawnOnboardingRipple,
} from "./onboarding-step-chrome";

function ConnectedIcon({ title }: { title: string }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <title>{title}</title>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function VoiceProviderStep() {
  const {
    elizaCloudConnected,
    onboardingCloudApiKey,
    onboardingVoiceApiKey,
    setState,
    handleOnboardingNext,
    handleOnboardingBack,
    t,
  } = useApp();
  const cloudVoiceReady =
    elizaCloudConnected || onboardingCloudApiKey.trim().length > 0;

  return (
    <>
      <OnboardingStepHeader
        eyebrow={t("onboarding.voiceProviderTitle")}
        description={t("onboarding.voiceProviderDesc")}
        descriptionClassName="mx-auto mt-1 max-w-[34ch] text-balance"
      />

      <div className={onboardingDetailStackClassName}>
        {cloudVoiceReady ? (
          <div className={onboardingCenteredStackClassName}>
            <OnboardingStatusBanner tone="success">
              <ConnectedIcon title={t("onboarding.connected")} />
              {t("onboarding.rpcConnectedCloud")}
            </OnboardingStatusBanner>
          </div>
        ) : (
          <div className={onboardingInfoPanelClassName}>
            <OnboardingField
              controlId="voice-api-key"
              label={t("onboarding.elevenLabsApiKey", {
                defaultValue: "ElevenLabs API Key",
              })}
            >
              {({ describedBy, invalid }) => (
                <Input
                  id="voice-api-key"
                  type="password"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className={onboardingInputClassName}
                  value={onboardingVoiceApiKey || ""}
                  onChange={(e) => {
                    setState("onboardingVoiceApiKey", e.target.value);
                    if (e.target.value.trim().length > 0) {
                      setState("onboardingVoiceProvider", "elevenlabs");
                    } else {
                      setState("onboardingVoiceProvider", "");
                    }
                  }}
                  placeholder="sk_..."
                />
              )}
            </OnboardingField>
          </div>
        )}
      </div>

      <div className={onboardingFooterClass}>
        <Button
          variant="ghost"
          className={onboardingSecondaryActionClass}
          style={onboardingSecondaryActionTextShadowStyle}
          onClick={handleOnboardingBack}
          type="button"
        >
          {t("onboarding.back")}
        </Button>
        <Button
          className={onboardingPrimaryActionClass}
          style={onboardingPrimaryActionTextShadowStyle}
          onClick={(event) => {
            spawnOnboardingRipple(event.currentTarget, {
              x: event.clientX,
              y: event.clientY,
            });
            void handleOnboardingNext();
          }}
          type="button"
        >
          {cloudVoiceReady || onboardingVoiceApiKey
            ? t("onboarding.next")
            : t("onboarding.skip")}
        </Button>
      </div>
    </>
  );
}
