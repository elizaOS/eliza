
import {
  OnboardingSecondaryActionButton,
  onboardingFooterClass,
  onboardingPrimaryActionClass,
  onboardingPrimaryActionTextShadowStyle,
  spawnOnboardingRipple,
} from "./onboarding-step-chrome";
import { useCallback, useMemo } from "react";
import { useApp } from "../../state";
import { FeatureCard, type FeatureStatus } from "./features/FeatureCard";
import { Button } from "@elizaos/ui";

const MONO_FONT = "'Courier New', 'Courier', 'Monaco', monospace";

interface FeatureDef {
  id: string;
  icon: string;
  nameKey: string;
  nameDefault: string;
  descKey: string;
  descDefault: string;
  managed: boolean;
  /** Only show when cloud is available */
  cloudOnly: boolean;
}

const FEATURES: FeatureDef[] = [
  {
    id: "telegram",
    icon: "\u2708\uFE0F",
    nameKey: "onboarding.features.telegram.name",
    nameDefault: "Telegram",
    descKey: "onboarding.features.telegram.desc",
    descDefault:
      "Message your agent on Telegram. Fully managed via Eliza Cloud.",
    managed: true,
    cloudOnly: true,
  },
  {
    id: "discord",
    icon: "\uD83C\uDFAE",
    nameKey: "onboarding.features.discord.name",
    nameDefault: "Discord",
    descKey: "onboarding.features.discord.desc",
    descDefault:
      "Connect your agent to Discord. Fully managed via Eliza Cloud.",
    managed: true,
    cloudOnly: true,
  },
  {
    id: "crypto",
    icon: "\u26D3\uFE0F",
    nameKey: "onboarding.features.crypto.name",
    nameDefault: "Crypto Wallet",
    descKey: "onboarding.features.crypto.desc",
    descDefault: "Enable blockchain capabilities with Solana and EVM wallets.",
    managed: false,
    cloudOnly: false,
  },
  {
    id: "browser",
    icon: "\uD83C\uDF10",
    nameKey: "onboarding.features.browser.name",
    nameDefault: "Browser",
    descKey: "onboarding.features.browser.desc",
    descDefault: "Pair with the LifeOps browser extension for web automation.",
    managed: false,
    cloudOnly: false,
  },
  {
    id: "computeruse",
    icon: "\uD83D\uDDA5\uFE0F",
    nameKey: "onboarding.features.computeruse.name",
    nameDefault: "Computer Use",
    descKey: "onboarding.features.computeruse.desc",
    descDefault:
      "Let your agent control mouse, keyboard, take screenshots, and automate browsers. Requires Accessibility and Screen Recording permissions.",
    managed: false,
    cloudOnly: false,
  },
];

const FEATURE_STATE_KEYS: Record<string, string> = {
  telegram: "onboardingFeatureTelegram",
  discord: "onboardingFeatureDiscord",
  crypto: "onboardingFeatureCrypto",
  browser: "onboardingFeatureBrowser",
  computeruse: "onboardingFeatureComputerUse",
};

export function FeaturesStep() {
  const {
    elizaCloudConnected,
    onboardingServerTarget,
    onboardingFeatureTelegram,
    onboardingFeatureDiscord,
    onboardingFeatureCrypto,
    onboardingFeatureBrowser,
    onboardingFeatureComputerUse,
    onboardingFeatureOAuthPending,
    setState,
    handleOnboardingNext,
    handleOnboardingBack,
    t,
  } = useApp();

  const hasCloud =
    elizaCloudConnected || onboardingServerTarget === "elizacloud";

  const enabledMap: Record<string, boolean> = useMemo(
    () => ({
      telegram: onboardingFeatureTelegram,
      discord: onboardingFeatureDiscord,
      crypto: onboardingFeatureCrypto,
      browser: onboardingFeatureBrowser,
      computeruse: onboardingFeatureComputerUse,
    }),
    [
      onboardingFeatureTelegram,
      onboardingFeatureDiscord,
      onboardingFeatureCrypto,
      onboardingFeatureBrowser,
    ],
  );

  const visibleFeatures = useMemo(
    () => FEATURES.filter((f) => !f.cloudOnly || hasCloud),
    [hasCloud],
  );

  const getStatus = useCallback(
    (id: string): FeatureStatus => {
      if (onboardingFeatureOAuthPending === id) return "connecting";
      if (enabledMap[id]) return "connected";
      return "disconnected";
    },
    [onboardingFeatureOAuthPending, enabledMap],
  );

  const handleToggle = useCallback(
    (id: string, enabled: boolean) => {
      const key = FEATURE_STATE_KEYS[id];
      // Safe cast — keys are known onboarding state fields
      if (key) setState(key as "onboardingFeatureTelegram", enabled);
      // TODO: For managed connectors, initiate OAuth flow when enabling.
      // For now, just toggle the state. The OAuth plumbing will be connected
      // when the cloud backend managed services are wired in (Phase 5).
    },
    [setState],
  );

  const handleContinue = useCallback(() => {
    handleOnboardingNext();
  }, [handleOnboardingNext]);

  const anyEnabled = Object.values(enabledMap).some(Boolean);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div>
        <h2
          style={{ fontFamily: MONO_FONT }}
          className="text-base font-bold text-black"
        >
          {t("onboarding.features.title", {
            defaultValue: "Enable features",
          })}
        </h2>
        <p className="mt-1 text-xs text-black/60">
          {t("onboarding.features.subtitle", {
            defaultValue:
              "Connect platforms and capabilities. You can always change these later in Settings.",
          })}
        </p>
      </div>

      {/* Feature grid */}
      <div className="flex flex-col gap-2">
        {hasCloud && (
          <p
            style={{ fontFamily: MONO_FONT }}
            className="text-3xs uppercase text-black/50 mt-1"
          >
            {t("onboarding.features.managedSection", {
              defaultValue: "Managed connectors",
            })}
          </p>
        )}

        {visibleFeatures
          .filter((f) => f.managed)
          .map((feature) => (
            <FeatureCard
              key={feature.id}
              icon={<span>{feature.icon}</span>}
              name={t(feature.nameKey, { defaultValue: feature.nameDefault })}
              description={t(feature.descKey, {
                defaultValue: feature.descDefault,
              })}
              status={getStatus(feature.id)}
              enabled={enabledMap[feature.id] ?? false}
              managed={feature.managed}
              onToggle={(enabled) => handleToggle(feature.id, enabled)}
              t={t}
            />
          ))}

        <p
          style={{ fontFamily: MONO_FONT }}
          className="text-3xs uppercase text-black/50 mt-2"
        >
          {t("onboarding.features.optionalSection", {
            defaultValue: "Optional capabilities",
          })}
        </p>

        {visibleFeatures
          .filter((f) => !f.managed)
          .map((feature) => (
            <FeatureCard
              key={feature.id}
              icon={<span>{feature.icon}</span>}
              name={t(feature.nameKey, { defaultValue: feature.nameDefault })}
              description={t(feature.descKey, {
                defaultValue: feature.descDefault,
              })}
              status={getStatus(feature.id)}
              enabled={enabledMap[feature.id] ?? false}
              managed={feature.managed}
              onToggle={(enabled) => handleToggle(feature.id, enabled)}
              t={t}
            />
          ))}
      </div>

      {/* Actions */}
      <div className={onboardingFooterClass}>
        <OnboardingSecondaryActionButton onClick={handleOnboardingBack}>
          {t("onboarding.back")}
        </OnboardingSecondaryActionButton>

        <Button
          type="button"
          className={onboardingPrimaryActionClass}
          style={onboardingPrimaryActionTextShadowStyle}
          onClick={(e) => {
            spawnOnboardingRipple(e.currentTarget, {
              x: e.clientX,
              y: e.clientY,
            });
            handleContinue();
          }}
        >
          {anyEnabled
            ? t("onboarding.features.continue", { defaultValue: "Continue" })
            : t("onboarding.features.continueWithout", {
                defaultValue: "Continue without features",
              })}
        </Button>
      </div>
    </div>
  );
}
