/** Maps tenant appearance settings to login CSS variables, inheriting the host palette by default. */
import type { TenantTheme } from "./types.js";

export const DEFAULT_THEME: TenantTheme = {
  primaryColor: "var(--accent, #ff6a1f)",
  accentColor: "var(--accent, #ff6a1f)",
  backgroundColor: "var(--bg, #000000)",
  surfaceColor: "var(--card, #111111)",
  textColor: "var(--text, #fdfaf7)",
  mutedColor: "var(--muted, #999999)",
  successColor: "var(--status-success, #22c55e)",
  errorColor: "var(--status-danger, #ff6a1f)",
  warningColor: "var(--status-warning, #ff6a1f)",
  borderRadius: 8,
  fontFamily: "Inter, system-ui, sans-serif",
  colorScheme: "dark",
};

export function mergeTheme(
  base: TenantTheme,
  overrides?: Partial<TenantTheme>,
): TenantTheme {
  if (!overrides) return base;
  return { ...base, ...overrides };
}
