/**
 * Theme application engine.
 *
 * Applies a ThemeDefinition to the document root by setting CSS custom
 * properties. Works with the existing Tailwind @theme inline mapping
 * in styles.css — changing CSS vars automatically updates Tailwind tokens.
 */

import {
  THEME_CSS_VAR_MAP,
  THEME_FONT_CSS_VARS,
  THEME_FONT_LINK_ID,
  type ThemeColorSet,
  type ThemeDefinition,
  type ThemeFonts,
} from "@elizaos/shared";

/**
 * Apply a theme's color set for the given mode to the document root.
 * Returns a cleanup function that removes all applied properties.
 */
export function applyThemeToDocument(
  theme: ThemeDefinition,
  mode: "light" | "dark",
): () => void {
  if (typeof document === "undefined") return () => {};

  const root = document.documentElement;
  const colorSet = mode === "dark" ? theme.dark : theme.light;
  const applied: string[] = [];

  // Apply color tokens
  for (const [key, cssVar] of Object.entries(THEME_CSS_VAR_MAP)) {
    const value = colorSet[key as keyof ThemeColorSet];
    if (value != null) {
      root.style.setProperty(cssVar, value);
      applied.push(cssVar);
    }
  }

  // Keep --txt in sync with --text (it's an alias consumed by Tailwind)
  if (colorSet.text != null) {
    root.style.setProperty("--txt", colorSet.text);
    applied.push("--txt");
  }

  // Keep --primary/--primary-foreground in sync if not explicitly set
  // (most themes share accent = primary)
  if (colorSet.accent != null && colorSet.primary == null) {
    root.style.setProperty("--primary", colorSet.accent);
    applied.push("--primary");
  }
  if (colorSet.accentForeground != null && colorSet.primaryForeground == null) {
    root.style.setProperty("--primary-foreground", colorSet.accentForeground);
    applied.push("--primary-foreground");
  }

  // Apply fonts
  if (theme.fonts) {
    applyThemeFonts(theme.fonts, applied);
  }

  return () => {
    for (const cssVar of applied) {
      root.style.removeProperty(cssVar);
    }
    removeFontLink();
  };
}

/**
 * Remove all theme-applied CSS custom properties from the document root,
 * restoring base.css defaults.
 */
export function clearThemeOverrides(): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;

  for (const cssVar of Object.values(THEME_CSS_VAR_MAP)) {
    root.style.removeProperty(cssVar);
  }
  // Aliases
  root.style.removeProperty("--txt");

  // Font vars
  for (const cssVar of Object.values(THEME_FONT_CSS_VARS)) {
    root.style.removeProperty(cssVar);
  }

  removeFontLink();
}

// ── Font helpers ───────────────────────────────────────────────────

function applyThemeFonts(fonts: ThemeFonts, applied: string[]): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;

  if (fonts.body) {
    root.style.setProperty(THEME_FONT_CSS_VARS.body, fonts.body);
    applied.push(THEME_FONT_CSS_VARS.body);
  }
  if (fonts.display) {
    root.style.setProperty(THEME_FONT_CSS_VARS.display, fonts.display);
    applied.push(THEME_FONT_CSS_VARS.display);
  }
  if (fonts.chat) {
    root.style.setProperty(THEME_FONT_CSS_VARS.chat, fonts.chat);
    applied.push(THEME_FONT_CSS_VARS.chat);
  }
  if (fonts.mono) {
    root.style.setProperty(THEME_FONT_CSS_VARS.mono, fonts.mono);
    applied.push(THEME_FONT_CSS_VARS.mono);
  }

  // Inject external font stylesheet
  if (fonts.fontImportUrl) {
    injectFontLink(fonts.fontImportUrl);
  } else {
    removeFontLink();
  }
}

function injectFontLink(url: string): void {
  if (typeof document === "undefined") return;

  const existing = document.getElementById(THEME_FONT_LINK_ID);
  if (existing instanceof HTMLLinkElement && existing.href === url) {
    return; // already loaded
  }

  // Remove stale link first
  existing?.remove();

  const link = document.createElement("link");
  link.id = THEME_FONT_LINK_ID;
  link.rel = "stylesheet";
  link.href = url;
  // Ensure content renders with fallback fonts while loading
  link.media = "all";
  document.head.appendChild(link);
}

function removeFontLink(): void {
  if (typeof document === "undefined") return;
  document.getElementById(THEME_FONT_LINK_ID)?.remove();
}

