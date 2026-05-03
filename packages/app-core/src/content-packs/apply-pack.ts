/**
 * Content pack application.
 *
 * Takes a ResolvedContentPack and applies its assets to the app state.
 * This is called from the splash page after the user selects a pack.
 */

import type {
  ContentPackColorScheme,
  ResolvedContentPack,
} from "@elizaos/shared";
import { applyThemeToDocument } from "../themes/apply-theme";

/** Minimal state setters needed to apply a content pack. */
export interface ContentPackApplyDeps {
  setCustomVrmUrl: (url: string) => void;
  setCustomVrmPreviewUrl: (url: string) => void;
  setCustomBackgroundUrl: (url: string) => void;
  setCustomWorldUrl: (url: string) => void;
  setSelectedVrmIndex: (index: number) => void;
  setOnboardingName: (name: string) => void;
  setOnboardingStyle: (style: string) => void;
  setCustomCatchphrase: (phrase: string) => void;
  setCustomVoicePresetId: (id: string) => void;
}

/**
 * Apply a content pack to the app state.
 * Call this on the splash page after the user selects a pack.
 */
export function applyContentPack(
  pack: ResolvedContentPack,
  deps: ContentPackApplyDeps,
): void {
  // VRM — bundled packs use avatarIndex, custom packs use vrmUrl
  if (pack.avatarIndex != null && pack.avatarIndex > 0) {
    deps.setSelectedVrmIndex(pack.avatarIndex);
    deps.setCustomVrmUrl("");
    deps.setCustomVrmPreviewUrl("");
  } else if (pack.vrmUrl) {
    deps.setCustomVrmUrl(pack.vrmUrl);
    deps.setCustomVrmPreviewUrl(pack.vrmPreviewUrl ?? "");
    deps.setSelectedVrmIndex(0); // 0 = custom VRM
  }

  // Background
  if (pack.backgroundUrl) {
    deps.setCustomBackgroundUrl(pack.backgroundUrl);
  }

  // Companion world scene
  deps.setCustomWorldUrl(pack.worldUrl ?? "");

  // Personality
  if (pack.personality?.name) {
    deps.setOnboardingName(pack.personality.name);
  }
  if (pack.personality?.catchphrase) {
    deps.setCustomCatchphrase(pack.personality.catchphrase);
  }
  if (pack.personality?.voicePresetId) {
    deps.setCustomVoicePresetId(pack.personality.voicePresetId);
  }
  if (pack.avatarIndex != null && pack.avatarIndex > 0 && pack.manifest.id) {
    deps.setOnboardingStyle(pack.manifest.id);
  }
}

// ── Color scheme CSS variable application ───────────────────────────

const COLOR_SCHEME_CSS_MAP: Record<
  keyof Omit<ContentPackColorScheme, "customProperties">,
  string
> = {
  accent: "--pack-accent",
  bg: "--pack-bg",
  card: "--pack-card",
  border: "--pack-border",
  text: "--pack-text",
  textMuted: "--pack-text-muted",
};

/**
 * Apply a content pack's color scheme as CSS custom properties on the
 * document root. Returns a cleanup function that removes them.
 *
 * If the pack includes a full ThemeDefinition (via `theme` field),
 * it takes precedence over the narrow colorScheme.
 */
export function applyColorScheme(
  scheme: ContentPackColorScheme | undefined,
  pack?: ResolvedContentPack,
): () => void {
  // Full theme takes precedence
  if (pack?.manifest.assets.theme) {
    const mode =
      typeof document !== "undefined" &&
      document.documentElement.getAttribute("data-theme") === "light"
        ? "light"
        : "dark";
    return applyThemeToDocument(pack.manifest.assets.theme, mode);
  }

  if (!scheme || typeof document === "undefined") return () => {};

  const root = document.documentElement;
  const applied: string[] = [];

  for (const [key, cssVar] of Object.entries(COLOR_SCHEME_CSS_MAP)) {
    const value = scheme[key as keyof typeof COLOR_SCHEME_CSS_MAP];
    if (value) {
      root.style.setProperty(cssVar, value);
      applied.push(cssVar);
    }
  }

  if (scheme.customProperties) {
    for (const [key, value] of Object.entries(scheme.customProperties)) {
      // Sanitize: reject values containing url() to prevent external
      // resource fetches when CSS vars are consumed by components.
      if (/url\s*\(/i.test(value)) continue;
      const cssVar = key.startsWith("--") ? key : `--${key}`;
      root.style.setProperty(cssVar, value);
      applied.push(cssVar);
    }
  }

  return () => {
    for (const cssVar of applied) {
      root.style.removeProperty(cssVar);
    }
  };
}
