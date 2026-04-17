import { Button, cn } from "@elizaos/app-core";
import { useCallback, useMemo } from "react";
import { useApp } from "../../state";
import { FeatureCard, type FeatureStatus } from "./features/FeatureCard";
import { onboardingReadableTextMutedClassName } from "./onboarding-form-primitives";
import {
  OnboardingSecondaryActionButton,
  OnboardingStepHeader,
  onboardingFooterClass,
  onboardingPrimaryActionClass,
  onboardingPrimaryActionTextShadowStyle,
  spawnOnboardingRipple,
} from "./onboarding-step-chrome";

const MONO_FONT = "'Courier New', 'Courier', 'Monaco', monospace";

interface FeatureDef {
  id: string;
  icon: React.ReactNode;
  nameKey: string;
  nameDefault: string;
  descKey: string;
  descDefault: string;
  managed: boolean;
  /** Only show when cloud is available */
  cloudOnly: boolean;
}

/** Brand blues — explicit `color` so `fill="currentColor"` stays visible on dark onboarding panels. */
const TelegramIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    className="shrink-0 text-[#2AABEE]"
    fill="currentColor"
    aria-hidden={true}
  >
    <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z" />
  </svg>
);

const DiscordIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="20"
    height="20"
    className="shrink-0 text-[#5865F2]"
    fill="currentColor"
    aria-hidden={true}
  >
    <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
);

const FEATURES: FeatureDef[] = [
  {
    id: "telegram",
    icon: <TelegramIcon />,
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
    icon: <DiscordIcon />,
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
    handleOnboardingJumpToStep,
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
      onboardingFeatureComputerUse,
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
    },
    [setState],
  );

  const handleContinue = useCallback(() => {
    handleOnboardingNext();
  }, [handleOnboardingNext]);

  /** Same path as the step nav pills — goes to providers with jump guards + connection reset rules. */
  const handleBackToProviders = useCallback(() => {
    handleOnboardingJumpToStep("providers");
  }, [handleOnboardingJumpToStep]);

  const anyEnabled = Object.values(enabledMap).some(Boolean);

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <OnboardingStepHeader
        eyebrow={t("onboarding.features.eyebrow", { defaultValue: "Features" })}
        title={t("onboarding.features.title", {
          defaultValue: "Enable features",
        })}
        description={t("onboarding.features.subtitle", {
          defaultValue:
            "Connect platforms and capabilities. You can always change these later in Settings.",
        })}
      />

      {/* Feature grid */}
      <div className="flex flex-col gap-2">
        {hasCloud && (
          <p
            style={{ fontFamily: MONO_FONT }}
            className={cn(
              "text-3xs uppercase mt-1",
              onboardingReadableTextMutedClassName,
            )}
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
              icon={feature.icon}
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
          className={cn(
            "text-3xs uppercase mt-2",
            onboardingReadableTextMutedClassName,
          )}
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
              icon={feature.icon}
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
        <OnboardingSecondaryActionButton onClick={handleBackToProviders}>
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
