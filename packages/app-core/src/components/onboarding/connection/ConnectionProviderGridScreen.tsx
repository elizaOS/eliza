import { Button } from "@elizaos/ui/components/ui/button";
import type { ProviderOption } from "../../../api";
import { appNameInterpolationVars, useBranding } from "../../../config";
import type {
  ConnectionEffect,
  ConnectionEvent,
} from "../../../onboarding/connection-flow";
import { CONNECTION_RECOMMENDED_PROVIDER_IDS } from "../../../onboarding/connection-flow";
import { getProviderLogo } from "../../../providers";
import { useApp } from "../../../state";
import {
  getOnboardingChoiceCardClassName,
  onboardingChoiceCardDescriptionClassName,
  onboardingChoiceCardDetectedBadgeClassName,
  onboardingChoiceCardRecommendedLabelClassName,
  onboardingChoiceCardTitleClassName,
} from "../onboarding-form-primitives";
import {
  OnboardingStepHeader,
  onboardingBodyTextShadowStyle,
  onboardingFooterClass,
  onboardingSecondaryActionClass,
  onboardingSecondaryActionTextShadowStyle,
} from "../onboarding-step-chrome";

const recommendedIds = new Set<string>(CONNECTION_RECOMMENDED_PROVIDER_IDS);

export function ConnectionProviderGridScreen({
  dispatch,
  onTransitionEffect,
  sortedProviders,
  getProviderDisplay,
  getCustomLogo,
  getDetectedLabel,
}: {
  dispatch: (event: ConnectionEvent) => void;
  onTransitionEffect: (effect: ConnectionEffect) => void;
  sortedProviders: ProviderOption[];
  getProviderDisplay: (provider: ProviderOption) => {
    name: string;
    description?: string;
  };
  getCustomLogo: (id: string) =>
    | {
        logoDark?: string;
        logoLight?: string;
      }
    | undefined;
  getDetectedLabel: (providerId: string) => string | null;
}) {
  const branding = useBranding();
  const { t, onboardingRemoteConnected, handleOnboardingNext } = useApp();

  return (
    <>
      <OnboardingStepHeader
        eyebrow={t("onboarding.neuralLinkTitle")}
        title={t("onboarding.chooseProvider")}
      />
      {onboardingRemoteConnected && (
        <p
          className="mx-auto mb-3 mt-1 max-w-[32ch] text-center text-xs leading-[1.4] text-[var(--onboarding-text-subtle)]"
          style={onboardingBodyTextShadowStyle}
        >
          {t(
            "onboarding.remoteConnectedDesc",
            appNameInterpolationVars(branding),
          )}
        </p>
      )}
      <div className="mb-5 grid grid-cols-1 gap-2 min-[440px]:grid-cols-2">
        {sortedProviders.map((p: ProviderOption) => {
          const display = getProviderDisplay(p);
          const isRecommended = recommendedIds.has(p.id);
          const detectedLabel = getDetectedLabel(p.id);
          return (
            <Button
              type="button"
              key={p.id}
              className={`${getOnboardingChoiceCardClassName({
                detected: Boolean(detectedLabel),
                recommended: isRecommended,
              })} h-auto min-w-0 justify-start overflow-hidden whitespace-normal px-[10px] py-[8px] ${isRecommended ? "min-[440px]:col-span-2" : ""}`}
              onClick={() =>
                dispatch({ type: "selectProvider", providerId: p.id })
              }
            >
              <div className="flex min-h-touch w-full items-center gap-2.5">
                <img
                  src={getProviderLogo(p.id, true, getCustomLogo(p.id))}
                  alt=""
                  className="h-[22px] w-[22px] shrink-0 rounded-md object-contain"
                />
                <div className="min-w-0 flex-1">
                  <div
                    className={`${onboardingChoiceCardTitleClassName} truncate`}
                  >
                    {display.name}
                  </div>
                  {display.description && (
                    <div
                      className={`${onboardingChoiceCardDescriptionClassName} truncate`}
                    >
                      {display.description}
                    </div>
                  )}
                </div>
                {detectedLabel && (
                  <span className={onboardingChoiceCardDetectedBadgeClassName}>
                    {detectedLabel}
                  </span>
                )}
                {isRecommended && !detectedLabel && (
                  <span
                    className={onboardingChoiceCardRecommendedLabelClassName}
                  >
                    {t("onboarding.recommended") ?? "Recommended"}
                  </span>
                )}
              </div>
            </Button>
          );
        })}
      </div>
      <div className={`${onboardingFooterClass} pb-1`}>
        <Button
          variant="ghost"
          className={onboardingSecondaryActionClass}
          style={onboardingSecondaryActionTextShadowStyle}
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
        </Button>
        <Button
          variant="ghost"
          className={onboardingSecondaryActionClass}
          style={onboardingSecondaryActionTextShadowStyle}
          onClick={() => {
            void handleOnboardingNext();
          }}
          type="button"
        >
          {t("onboarding.configureAiLater", {
            defaultValue: "Set up later",
          })}
        </Button>
      </div>
    </>
  );
}
