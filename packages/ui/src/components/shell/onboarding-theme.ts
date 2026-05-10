import type { CSSProperties } from "react";
import type { OnboardingThemeConfig } from "../../config/branding";

type OnboardingCssVars = CSSProperties & Record<`--${string}`, string>;

const DEFAULT_ONBOARDING_THEME = {
  background: "#c84d1f",
  foreground: "#fffaf6",
  mutedForeground: "rgba(255, 250, 246, 0.72)",
  controlBackground: "rgba(255, 255, 255, 0.16)",
  controlForeground: "#fffaf6",
  buttonBackground: "#fffaf6",
  buttonForeground: "#c84d1f",
  buttonHighlightBackground: "#ffe7d9",
  inputBackground: "#fffaf6",
  inputForeground: "#9f3a18",
  errorForeground: "#fff0e8",
} satisfies Required<OnboardingThemeConfig>;

export function getOnboardingThemeVars(
  theme: OnboardingThemeConfig | undefined,
): OnboardingCssVars {
  const resolved = { ...DEFAULT_ONBOARDING_THEME, ...theme };
  return {
    "--onboarding-bg": resolved.background,
    "--onboarding-fg": resolved.foreground,
    "--onboarding-muted": resolved.mutedForeground,
    "--onboarding-control-bg": resolved.controlBackground,
    "--onboarding-control-fg": resolved.controlForeground,
    "--onboarding-button-bg": resolved.buttonBackground,
    "--onboarding-button-fg": resolved.buttonForeground,
    "--onboarding-button-highlight": resolved.buttonHighlightBackground,
    "--onboarding-input-bg-flat": resolved.inputBackground,
    "--onboarding-input-fg-flat": resolved.inputForeground,
    "--onboarding-error": resolved.errorForeground,
  };
}
