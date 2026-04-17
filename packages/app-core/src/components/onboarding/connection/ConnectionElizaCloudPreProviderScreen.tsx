import { Button, Input } from "@elizaos/ui";
import type { ChangeEvent } from "react";
import { useBranding } from "../../../config";
import type { ConnectionEvent } from "../../../onboarding/connection-flow";
import { useApp } from "../../../state";
import { openExternalUrl } from "../../../utils";
import { OnboardingTabs } from "../OnboardingTabs";
import {
  OnboardingField,
  OnboardingStatusBanner,
  onboardingCenteredStackClassName,
  onboardingDetailStackClassName,
  onboardingHelperTextClassName,
  onboardingInputClassName,
} from "../onboarding-form-primitives";
import {
  OnboardingLinkActionButton,
  OnboardingSecondaryActionButton,
  OnboardingStepHeader,
  onboardingFooterClass,
  onboardingPrimaryActionClass,
  onboardingPrimaryActionTextShadowStyle,
  spawnOnboardingRipple,
} from "../onboarding-step-chrome";
import { useAdvanceOnboardingWhenElizaCloudOAuthConnected } from "./useAdvanceOnboardingWhenElizaCloudOAuthConnected";

export function ConnectionElizaCloudPreProviderScreen({
  dispatch,
}: {
  dispatch: (event: ConnectionEvent) => void;
}) {
  const branding = useBranding();
  const {
    t,
    onboardingCloudApiKey,
    onboardingElizaCloudTab,
    elizaCloudConnected,
    elizaCloudLoginBusy,
    elizaCloudLoginError,
    handleCloudLogin,
    handleOnboardingNext,
    setState,
  } = useApp();

  const elizaCloudReady =
    elizaCloudConnected || onboardingCloudApiKey.trim().length > 0;

  useAdvanceOnboardingWhenElizaCloudOAuthConnected({
    active: true,
    elizaCloudConnected,
    elizaCloudTab: onboardingElizaCloudTab,
    handleOnboardingNext,
  });

  const handleApiKeyChange = (e: ChangeEvent<HTMLInputElement>) => {
    setState("onboardingCloudApiKey", e.target.value);
  };

  return (
    <>
      <OnboardingStepHeader eyebrow="Eliza Cloud" />

      <div className="w-full text-left">
        <OnboardingTabs
          tabs={[
            { id: "login" as const, label: t("onboarding.login") },
            { id: "apikey" as const, label: t("onboarding.apiKey") },
          ]}
          active={onboardingElizaCloudTab}
          onChange={(tab) => dispatch({ type: "setElizaCloudTab", tab })}
        />

        {onboardingElizaCloudTab === "login" ? (
          <div className={onboardingCenteredStackClassName}>
            {elizaCloudConnected ? (
              <OnboardingStatusBanner tone="success">
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <title>{t("onboarding.connected")}</title>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                {t("onboarding.connected")}
              </OnboardingStatusBanner>
            ) : (
              <Button
                type="button"
                className={onboardingPrimaryActionClass}
                style={onboardingPrimaryActionTextShadowStyle}
                onClick={(e) => {
                  spawnOnboardingRipple(e.currentTarget, {
                    x: e.clientX,
                    y: e.clientY,
                  });
                  handleCloudLogin();
                }}
                disabled={elizaCloudLoginBusy}
              >
                {elizaCloudLoginBusy
                  ? t("onboarding.connecting")
                  : t("onboarding.connectAccount")}
              </Button>
            )}
            {elizaCloudLoginError &&
              (() => {
                const urlMatch = elizaCloudLoginError.match(
                  /^Open this link to log in: (.+)$/,
                );
                if (urlMatch) {
                  return (
                    <OnboardingStatusBanner
                      tone="neutral"
                      action={
                        <OnboardingLinkActionButton
                          type="button"
                          onClick={() => openExternalUrl(urlMatch[1])}
                        >
                          {t("onboarding.openLoginPageInBrowser")}
                        </OnboardingLinkActionButton>
                      }
                    >
                      {t("onboarding.openLoginPageInBrowserDesc")}
                    </OnboardingStatusBanner>
                  );
                }
                return (
                  <OnboardingStatusBanner tone="error" live="assertive">
                    {elizaCloudLoginError}
                  </OnboardingStatusBanner>
                );
              })()}
            {elizaCloudLoginError ? (
              <OnboardingLinkActionButton
                type="button"
                className="mt-1 text-xs underline"
                onClick={() => openExternalUrl(branding.bugReportUrl)}
              >
                {t("onboarding.reportIssue")}
              </OnboardingLinkActionButton>
            ) : null}
            <p className={`${onboardingHelperTextClassName} text-center`}>
              {t("onboarding.freeCredits")}
            </p>
          </div>
        ) : (
          <div className={onboardingDetailStackClassName}>
            <OnboardingField
              align="center"
              controlId="elizacloud-apikey-pre"
              label={t("onboarding.apiKey")}
              description={
                <>
                  {t("onboarding.useExistingKey")}{" "}
                  <a
                    href="https://elizacloud.ai/dashboard/settings"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[var(--onboarding-link)] underline underline-offset-2 transition-colors duration-200 hover:text-[var(--onboarding-text-strong)]"
                  >
                    {t("onboarding.getOneHere")}
                  </a>
                </>
              }
            >
              {({ describedBy, invalid }) => (
                <Input
                  id="elizacloud-apikey-pre"
                  type="password"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  className={`${onboardingInputClassName} text-center`}
                  placeholder="ck-..."
                  value={onboardingCloudApiKey}
                  onChange={handleApiKeyChange}
                />
              )}
            </OnboardingField>
          </div>
        )}
      </div>

      <div className={onboardingFooterClass}>
        <OnboardingSecondaryActionButton
          onClick={() => dispatch({ type: "backElizaCloudPreProvider" })}
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
            void handleOnboardingNext();
          }}
          disabled={!elizaCloudReady}
          type="button"
        >
          {t("onboarding.confirm")}
        </Button>
      </div>
    </>
  );
}
