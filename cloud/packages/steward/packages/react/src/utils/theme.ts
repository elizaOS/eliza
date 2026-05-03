import type { TenantTheme } from "../types.js";

export const DEFAULT_THEME: TenantTheme = {
  primaryColor: "#D4A054",
  accentColor: "#E0B060",
  backgroundColor: "#0B0A09",
  surfaceColor: "#1C1A17",
  textColor: "#E8E5E0",
  mutedColor: "#6B6560",
  successColor: "#4ADE80",
  errorColor: "#F87171",
  warningColor: "#FBBF24",
  borderRadius: 8,
  fontFamily: "Inter, system-ui, sans-serif",
  colorScheme: "dark",
};

export function themeToCSS(theme: TenantTheme): Record<string, string> {
  return {
    "--stwd-primary": theme.primaryColor,
    "--stwd-accent": theme.accentColor,
    "--stwd-bg": theme.backgroundColor,
    "--stwd-surface": theme.surfaceColor,
    "--stwd-text": theme.textColor,
    "--stwd-muted": theme.mutedColor,
    "--stwd-success": theme.successColor,
    "--stwd-error": theme.errorColor,
    "--stwd-warning": theme.warningColor,
    "--stwd-radius": `${theme.borderRadius}px`,
    "--stwd-font": theme.fontFamily || "Inter, system-ui, sans-serif",
  };
}

export function mergeTheme(base: TenantTheme, overrides?: Partial<TenantTheme>): TenantTheme {
  if (!overrides) return base;
  return { ...base, ...overrides };
}
