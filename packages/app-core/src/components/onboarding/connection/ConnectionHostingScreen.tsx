import { Button } from "@elizaos/ui";
import { appNameInterpolationVars, useBranding } from "../../../config";
import type { ConnectionEvent } from "../../../onboarding/connection-flow";
import { useApp } from "../../../state";
import {
  getOnboardingChoiceCardClassName,
  onboardingChoiceCardBadgeClassName,
  onboardingChoiceCardDescriptionClassName,
  onboardingChoiceCardTitleClassName,
} from "../onboarding-form-primitives";
import {
  OnboardingSecondaryActionButton,
  OnboardingStepHeader,
  onboardingFooterClass,
} from "../onboarding-step-chrome";

export function ConnectionHostingScreen({
  showHostingLocalCard,
  dispatch,
}: {
  showHostingLocalCard: boolean;
  dispatch: (event: ConnectionEvent) => void;
}) {
  const branding = useBranding();
  const { t, handleOnboardingBack } = useApp();

  return (
    <>
      <OnboardingStepHeader
        eyebrow={t("onboarding.hostingTitle")}
        title={t(
          "onboarding.hostingQuestion",
          appNameInterpolationVars(branding),
        )}
      />
      <div className="flex flex-col gap-2">
        {showHostingLocalCard ? (
          <Button
            type="button"
            className={getOnboardingChoiceCardClassName({
              recommended: true,
            })}
            onClick={() => dispatch({ type: "selectLocalHosting" })}
          >
            <div className="min-w-0 flex-1">
              <div className={onboardingChoiceCardTitleClassName}>
                {t("onboarding.hostingLocal")}
              </div>
              <div
                className={`${onboardingChoiceCardDescriptionClassName} line-clamp-2`}
              >
                {t("onboarding.hostingLocalDesc")}
              </div>
            </div>
            <span className={onboardingChoiceCardBadgeClassName}>
              {t("onboarding.recommended") ?? "Recommended"}
            </span>
          </Button>
        ) : null}
        <Button
          type="button"
          className={getOnboardingChoiceCardClassName({})}
          onClick={() => dispatch({ type: "selectRemoteHosting" })}
        >
          <div className="min-w-0 flex-1">
            <div className={onboardingChoiceCardTitleClassName}>
              {t("onboarding.hostingRemote")}
            </div>
            <div
              className={`${onboardingChoiceCardDescriptionClassName} line-clamp-2`}
            >
              {t("onboarding.hostingRemoteDesc")}
            </div>
          </div>
        </Button>
        <Button
          type="button"
          className={getOnboardingChoiceCardClassName({})}
          onClick={() => dispatch({ type: "selectElizaCloudHosting" })}
        >
          <div className="min-w-0 flex-1">
            <div className={onboardingChoiceCardTitleClassName}>
              {t("header.Cloud")}
            </div>
            <div
              className={`${onboardingChoiceCardDescriptionClassName} line-clamp-2`}
            >
              {t("onboarding.hostingElizaCloudDesc")}
            </div>
          </div>
        </Button>
        <Button
          type="button"
          className={getOnboardingChoiceCardClassName({})}
          onClick={() => dispatch({ type: "selectElizaCloudHybridHosting" })}
        >
          <div className="min-w-0 flex-1">
            <div className={onboardingChoiceCardTitleClassName}>
              {t("onboarding.hostingElizaCloudHybrid")}
            </div>
            <div
              className={`${onboardingChoiceCardDescriptionClassName} line-clamp-2`}
            >
              {t("onboarding.hostingElizaCloudHybridDesc")}
            </div>
          </div>
        </Button>
      </div>
      <div className={onboardingFooterClass}>
        <OnboardingSecondaryActionButton
          onClick={handleOnboardingBack}
          type="button"
        >
          {t("onboarding.back")}
        </OnboardingSecondaryActionButton>
        <span />
      </div>
    </>
  );
}
