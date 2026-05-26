import type { CSSProperties } from "react";
import type { FirstRunThemeConfig } from "../../config/branding";

type FirstRunCssVars = CSSProperties & Record<`--${string}`, string>;

const DEFAULT_FIRST_RUN_THEME = {
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
} satisfies Required<FirstRunThemeConfig>;

export function getFirstRunThemeVars(
  theme: FirstRunThemeConfig | undefined,
): FirstRunCssVars {
  const resolved = { ...DEFAULT_FIRST_RUN_THEME, ...theme };
  return {
    "--first-run-bg": resolved.background,
    "--first-run-fg": resolved.foreground,
    "--first-run-muted": resolved.mutedForeground,
    "--first-run-control-bg": resolved.controlBackground,
    "--first-run-control-fg": resolved.controlForeground,
    "--first-run-button-bg": resolved.buttonBackground,
    "--first-run-button-fg": resolved.buttonForeground,
    "--first-run-button-highlight": resolved.buttonHighlightBackground,
    "--first-run-input-bg-flat": resolved.inputBackground,
    "--first-run-input-fg-flat": resolved.inputForeground,
    "--first-run-error": resolved.errorForeground,
  };
}
