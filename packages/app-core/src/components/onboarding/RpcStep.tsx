import { Button, Input } from "@elizaos/ui";

import { useState } from "react";
import { useApp } from "../../state/useApp";
import {
  onboardingCardSurfaceClassName,
  onboardingCardSurfaceHoverClassName,
  onboardingFieldLabelClassName,
  onboardingHelperTextClassName,
  onboardingInputClassName,
  onboardingReadableTextPrimaryClassName,
  onboardingRecommendedSurfaceClassName,
  onboardingRecommendedSurfaceHoverClassName,
  onboardingSubtleTextClassName,
} from "./onboarding-form-primitives";
import {
  OnboardingSecondaryActionButton,
  OnboardingStepHeader,
  onboardingBodyTextShadowStyle,
  onboardingFooterClass,
  onboardingPrimaryActionClass,
  onboardingPrimaryActionTextShadowStyle,
  spawnOnboardingRipple,
} from "./onboarding-step-chrome";

type RpcMode = "" | "cloud" | "byok";

const rpcModeCardBaseClass =
  "flex min-h-[76px] w-full items-center justify-center rounded-2xl px-4 py-3 text-center backdrop-blur-[18px] backdrop-saturate-[1.2] transition-all duration-300";

const rpcModeTitleClass = `text-sm font-semibold leading-tight ${onboardingReadableTextPrimaryClassName}`;

const rpcModeDescriptionClass = `mt-1 text-xs leading-[1.45] ${onboardingSubtleTextClassName}`;

const rpcCalloutClass = `mx-auto mt-4 flex w-full max-w-[25rem] items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm leading-relaxed backdrop-blur-sm ${onboardingCardSurfaceClassName}`;

const rpcFieldStackClass = "mx-auto w-full max-w-[27rem] space-y-4 text-left";

const rpcFieldLabelClass = `mb-1.5 block text-xs-tight tracking-[0.14em] ${onboardingFieldLabelClassName}`;

const rpcFieldHintClass = `mb-2 ${onboardingSubtleTextClassName}`;

const rpcInputClass = `${onboardingInputClassName} h-auto px-4 py-3 text-sm tracking-[0.01em]`;

function RpcModeCard({
  title,
  description,
  tone = "default",
  onClick,
}: {
  title: string;
  description: string;
  tone?: "default" | "recommended";
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant={tone === "recommended" ? "default" : "outline"}
      className={`${rpcModeCardBaseClass} ${
        tone === "recommended"
          ? `${onboardingRecommendedSurfaceClassName} ${onboardingRecommendedSurfaceHoverClassName}`
          : `${onboardingCardSurfaceClassName} ${onboardingCardSurfaceHoverClassName}`
      }`}
      onClick={onClick}
    >
      <div className="min-w-0">
        <div
          className={rpcModeTitleClass}
          style={onboardingBodyTextShadowStyle}
        >
          {title}
        </div>
        <div
          className={rpcModeDescriptionClass}
          style={onboardingBodyTextShadowStyle}
        >
          {description}
        </div>
      </div>
    </Button>
  );
}

function RpcKeyField({
  id,
  label,
  hint,
  placeholder,
  value,
  onChange,
}: {
  id: string;
  label: string;
  hint?: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <label htmlFor={id} className={rpcFieldLabelClass}>
        {label}
      </label>
      {hint ? <p className={rpcFieldHintClass}>{hint}</p> : null}
      <Input
        id={id}
        type="password"
        className={rpcInputClass}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function CloudLoginErrorMessage({ error }: { error: string }) {
  const { t } = useApp();
  const urlMatch = error.match(/^Open this link to log in: (.+)$/);
  if (urlMatch) {
    return (
      <p
        className={`mt-3 text-sm ${onboardingReadableTextPrimaryClassName}`}
        style={onboardingBodyTextShadowStyle}
      >
        {t("onboarding.openThisLinkToLogIn", {
          defaultValue: "Open this link to log in:",
        })}{" "}
        <a
          href={urlMatch[1]}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2"
        >
          {t("onboarding.clickHere", {
            defaultValue: "Click here",
          })}
        </a>
      </p>
    );
  }

  return (
    <div
      className={`${rpcCalloutClass} border-[color:color-mix(in_srgb,var(--danger)_42%,transparent)] bg-[color:color-mix(in_srgb,var(--danger)_12%,transparent)] text-danger`}
      role="alert"
      style={onboardingBodyTextShadowStyle}
    >
      {error}
    </div>
  );
}

export function RpcStep() {
  const {
    elizaCloudConnected,
    elizaCloudLoginBusy,
    elizaCloudLoginError,
    onboardingCloudApiKey,
    handleCloudLogin,
    handleOnboardingNext,
    handleOnboardingBack,
    onboardingRpcKeys,
    setState,
    t,
  } = useApp();

  const elizaCloudReady =
    elizaCloudConnected || onboardingCloudApiKey.trim().length > 0;
  const [mode, setMode] = useState<RpcMode>(elizaCloudReady ? "cloud" : "");

  const rpcKeys = onboardingRpcKeys as Record<string, string>;

  const setRpcKey = (key: string, value: string) => {
    setState("onboardingRpcKeys", { ...rpcKeys, [key]: value });
  };

  const applyCloudSelections = () => {
    setState("onboardingRpcSelections", {
      evm: "eliza-cloud",
      bsc: "eliza-cloud",
      solana: "eliza-cloud",
    });
  };

  if (!mode) {
    return (
      <>
        <OnboardingStepHeader
          eyebrow={t("onboarding.rpcTitle")}
          title={t("onboarding.rpcQuestion")}
          description={t("onboarding.rpcDesc")}
          descriptionClassName="mx-auto mt-1 max-w-[34ch] text-balance text-sm leading-6"
        />

        <div className="mx-auto flex w-full max-w-[25rem] flex-col gap-3">
          <RpcModeCard
            title={t("onboarding.rpcElizaCloud")}
            description={t("onboarding.rpcElizaCloudDesc")}
            tone="recommended"
            onClick={() => {
              if (elizaCloudConnected) {
                applyCloudSelections();
              }
              setMode("cloud");
            }}
          />
          <RpcModeCard
            title={t("onboarding.rpcBringKeys")}
            description={t("onboarding.rpcBringKeysProviders")}
            onClick={() => setMode("byok")}
          />
        </div>

        <div className={onboardingFooterClass}>
          <OnboardingSecondaryActionButton
            onClick={handleOnboardingBack}
            type="button"
          >
            {t("onboarding.back")}
          </OnboardingSecondaryActionButton>
          <OnboardingSecondaryActionButton
            onClick={() => void handleOnboardingNext()}
            type="button"
          >
            {t("onboarding.rpcSkip")}
          </OnboardingSecondaryActionButton>
        </div>
      </>
    );
  }

  if (mode === "cloud") {
    return (
      <>
        <OnboardingStepHeader
          eyebrow={t("onboarding.rpcTitle")}
          title={t("onboarding.rpcElizaCloud")}
          description={t("onboarding.rpcElizaCloudDesc")}
          descriptionClassName="mx-auto mt-1 max-w-[34ch] text-balance"
        />

        <div className="mx-auto w-full max-w-[25rem] text-center">
          {elizaCloudConnected ? (
            <div
              className={`${rpcCalloutClass} border-[var(--ok-muted)] bg-[var(--ok-subtle)] text-ok`}
              role="status"
              style={onboardingBodyTextShadowStyle}
            >
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
              {t("onboarding.rpcConnectedCloud")}
            </div>
          ) : (
            <>
              <Button
                type="button"
                className={`${onboardingPrimaryActionClass} w-full`}
                style={onboardingPrimaryActionTextShadowStyle}
                onClick={(event) => {
                  spawnOnboardingRipple(event.currentTarget, {
                    x: event.clientX,
                    y: event.clientY,
                  });
                  void handleCloudLogin();
                }}
                disabled={elizaCloudLoginBusy || elizaCloudReady}
              >
                {elizaCloudLoginBusy
                  ? t("onboarding.connecting")
                  : elizaCloudReady
                    ? t("onboarding.connected")
                    : t("onboarding.connectAccount")}
              </Button>
              {elizaCloudLoginError ? (
                <CloudLoginErrorMessage error={elizaCloudLoginError} />
              ) : null}
              <p
                className={`mt-3 ${onboardingHelperTextClassName}`}
                style={onboardingBodyTextShadowStyle}
              >
                {t("onboarding.freeCredits")}
              </p>
            </>
          )}
        </div>

        <div className={onboardingFooterClass}>
          <OnboardingSecondaryActionButton
            onClick={() => setMode("")}
            type="button"
          >
            {t("onboarding.back")}
          </OnboardingSecondaryActionButton>
          <Button
            className={onboardingPrimaryActionClass}
            style={onboardingPrimaryActionTextShadowStyle}
            onClick={() => {
              applyCloudSelections();
              void handleOnboardingNext();
            }}
            disabled={!elizaCloudReady}
            type="button"
          >
            {t("onboarding.next")}
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <OnboardingStepHeader
        eyebrow={t("onboarding.rpcTitle")}
        title={t("onboarding.rpcBringKeys")}
        description={t("onboarding.rpcBringKeysDescription")}
        descriptionClassName="mx-auto mt-1 max-w-[35ch] text-balance"
      />

      <div className={rpcFieldStackClass}>
        <RpcKeyField
          id="rpc-alchemy"
          label={t("onboarding.rpcAlchemyKey")}
          hint={t("onboarding.rpcAlchemyHint")}
          placeholder={t("onboarding.rpcAlchemyPlaceholder")}
          value={rpcKeys.ALCHEMY_API_KEY ?? ""}
          onChange={(value) => setRpcKey("ALCHEMY_API_KEY", value)}
        />
        <RpcKeyField
          id="rpc-helius"
          label={t("onboarding.rpcHeliusKey")}
          hint={t("onboarding.rpcHeliusHint")}
          placeholder={t("onboarding.rpcHeliusPlaceholder")}
          value={rpcKeys.HELIUS_API_KEY ?? ""}
          onChange={(value) => setRpcKey("HELIUS_API_KEY", value)}
        />
        <RpcKeyField
          id="rpc-birdeye"
          label={t("onboarding.rpcBirdeyeKey")}
          hint={t("onboarding.rpcBirdeyeHint")}
          placeholder={t("onboarding.rpcBirdeyePlaceholder")}
          value={rpcKeys.BIRDEYE_API_KEY ?? ""}
          onChange={(value) => setRpcKey("BIRDEYE_API_KEY", value)}
        />
      </div>

      <div className={onboardingFooterClass}>
        <OnboardingSecondaryActionButton
          onClick={() => setMode("")}
          type="button"
        >
          {t("onboarding.back")}
        </OnboardingSecondaryActionButton>
        <Button
          className={onboardingPrimaryActionClass}
          style={onboardingPrimaryActionTextShadowStyle}
          onClick={(event) => {
            spawnOnboardingRipple(event.currentTarget, {
              x: event.clientX,
              y: event.clientY,
            });

            const selections: Record<string, string> = {};
            if (rpcKeys.ALCHEMY_API_KEY) {
              selections.evm = "alchemy";
              selections.bsc = "alchemy";
            }
            if (rpcKeys.HELIUS_API_KEY) {
              selections.solana = "helius-birdeye";
            }
            setState("onboardingRpcSelections", selections);
            void handleOnboardingNext();
          }}
          type="button"
        >
          {t("onboarding.next")}
        </Button>
      </div>
    </>
  );
}
