import type { CSSProperties } from "react";
import type { OnboardingThemeConfig } from "../../config/branding";

type OnboardingCssVars = CSSProperties & Record<`--${string}`, string>;

const DEFAULT_ONBOARDING_THEME = {
  background: "#1d91e8",
  foreground: "#ffffff",
  mutedForeground: "rgba(255, 255, 255, 0.78)",
  controlBackground: "rgba(255, 255, 255, 0.18)",
  controlForeground: "#ffffff",
  buttonBackground: "#ff8a24",
  buttonForeground: "#fff7ee",
  buttonHighlightBackground: "#fff7ee",
  inputBackground: "rgba(255, 255, 255, 0.92)",
  inputForeground: "#06131f",
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
