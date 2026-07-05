/**
 * localStorage + server persistence for shell state: the active-server record,
 * UI language, favorite/recent apps, and background config/history. The single
 * read/write layer the state modules go through.
 */
import { logger } from "@elizaos/logger";
import { asRecord } from "@elizaos/shared";
import { fetchWithCsrf } from "../api/csrf-client";
import { isTerminalIosNativeAgentBootErrorMessage } from "../api/ios-local-agent-transport";
import {
  isPlausibleFragmentSource,
  normalizeUniforms,
} from "../backgrounds/shader-schema";
import { MAX_BACKGROUND_HISTORY } from "./background-history";

// Re-exported so existing `import { MAX_BACKGROUND_HISTORY } from "./persistence"`
// sites keep working; the single source is the pure reducer module.
export { MAX_BACKGROUND_HISTORY } from "./background-history";

import { getBootConfig } from "../config/boot-config-store";
import {
  DEFAULT_UI_LANGUAGE,
  normalizeLanguage,
  type UiLanguage,
} from "../i18n";
import { detectClientLanguage } from "../i18n/region";
import type { Tab } from "../navigation";
import { normalizeDirectCloudSharedAgentApiBase } from "../utils/cloud-agent-base";
import { DEFAULT_LOCAL_ASR_AUTO_STOP } from "../voice/local-asr-capture";
import {
  type BackgroundConfig,
  DEFAULT_ACCENT_ID,
  DEFAULT_BACKGROUND_COLOR,
  DEFAULT_BACKGROUND_CONFIG,
  normalizeAccentId,
  type UiShellMode,
  type UiTheme,
  type UiThemeMode,
} from "./ui-preferences";
import { normalizeAvatarIndex } from "./vrm";

/* ── Shared localStorage helper ──────────────────────────────────────── */

function tryLocalStorage<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    // error-policy:J3 localStorage can throw (private mode, quota, security
    // policy); preference reads start from their designed default rather than
    // wedging the shell on an inaccessible store.
    return fallback;
  }
}

function describePersistenceError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ── Theme persistence ────────────────────────────────────────────────── */

export type { UiTheme, UiThemeMode } from "./ui-preferences";

const UI_THEME_STORAGE_KEY = "eliza:ui-theme";
const LEGACY_UI_THEME_STORAGE_KEY = "elizaos:ui-theme";
const UI_THEME_MODE_STORAGE_KEY = "eliza:ui-theme-mode";

function normalizeUiThemeMode(value: unknown): UiThemeMode {
  return value === "light" || value === "dark" || value === "system"
    ? value
    : "system";
}

export { normalizeUiThemeMode };

/**
 * The app ships a single curated light look — there is no dark theme. Kept as a
 * function (not a constant) so existing callers and the system-change listener
 * keep their shape.
 */
export function getSystemTheme(): UiTheme {
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function"
  ) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "light";
}

/**
 * Resolve a {@link UiThemeMode} to a concrete {@link UiTheme}: an explicit
 * `light`/`dark` choice wins; `system` follows the OS color-scheme.
 */
export function resolveUiTheme(mode: UiThemeMode): UiTheme {
  return mode === "system" ? getSystemTheme() : mode;
}

/**
 * Load the persisted theme mode. New users (no stored value) default to
 * `system`. A legacy concrete `eliza:ui-theme` value is treated as an
 * explicit user choice and migrated into a `light`/`dark` mode.
 */
export function loadUiThemeMode(): UiThemeMode {
  return tryLocalStorage(() => {
    const mode = localStorage.getItem(UI_THEME_MODE_STORAGE_KEY);
    if (mode != null) return normalizeUiThemeMode(mode);
    const legacy =
      localStorage.getItem(UI_THEME_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_UI_THEME_STORAGE_KEY);
    return legacy === "light" || legacy === "dark" ? legacy : "system";
  }, "system");
}

/* ── Home time/date widget visibility (#10706) ───────────────────────── */

const HOME_TIME_WIDGET_HIDDEN_STORAGE_KEY = "eliza:home-time-widget-hidden";

/** Load whether the home time/date tile is hidden. Defaults to shown (false). */
export function loadHomeTimeWidgetHidden(): boolean {
  return tryLocalStorage(
    () => localStorage.getItem(HOME_TIME_WIDGET_HIDDEN_STORAGE_KEY) === "1",
    false,
  );
}

export function saveHomeTimeWidgetHidden(hidden: boolean): void {
  tryLocalStorage(() => {
    localStorage.setItem(
      HOME_TIME_WIDGET_HIDDEN_STORAGE_KEY,
      hidden ? "1" : "0",
    );
  }, undefined);
}

export function saveUiThemeMode(mode: UiThemeMode): void {
  tryLocalStorage(() => {
    localStorage.setItem(UI_THEME_MODE_STORAGE_KEY, normalizeUiThemeMode(mode));
  }, undefined);
}
const THEME_SWITCHING_ATTRIBUTE = "data-theme-switching";
let themeSwitchResetFrameId: number | null = null;

function normalizeUiTheme(value: unknown): UiTheme {
  return value === "light" ? "light" : "dark";
}

export { normalizeUiTheme };

function suppressThemeTransitions(root: HTMLElement): void {
  if (typeof window === "undefined") return;
  root.setAttribute(THEME_SWITCHING_ATTRIBUTE, "");
  if (themeSwitchResetFrameId != null) {
    window.cancelAnimationFrame(themeSwitchResetFrameId);
  }
  themeSwitchResetFrameId = window.requestAnimationFrame(() => {
    themeSwitchResetFrameId = window.requestAnimationFrame(() => {
      root.removeAttribute(THEME_SWITCHING_ATTRIBUTE);
      themeSwitchResetFrameId = null;
    });
  });
}

export function loadUiTheme(): UiTheme {
  return tryLocalStorage(() => {
    const current = localStorage.getItem(UI_THEME_STORAGE_KEY);
    if (current != null) return normalizeUiTheme(current);
    return normalizeUiTheme(localStorage.getItem(LEGACY_UI_THEME_STORAGE_KEY));
  }, "dark");
}

export function saveUiTheme(theme: UiTheme): void {
  tryLocalStorage(() => {
    const normalized = normalizeUiTheme(theme);
    localStorage.setItem(UI_THEME_STORAGE_KEY, normalized);
    localStorage.setItem(LEGACY_UI_THEME_STORAGE_KEY, normalized);
  }, undefined);
}

/* ── Background persistence ───────────────────────────────────────────── */

const UI_BACKGROUND_STORAGE_KEY = "eliza:ui-background";

/** Accept a 6-digit hex color; anything else falls back to the default. */
function normalizeHexColor(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value.toLowerCase()
    : DEFAULT_BACKGROUND_COLOR;
}

export function normalizeBackgroundConfig(value: unknown): BackgroundConfig {
  const record = asRecord(value);
  if (!record) return { ...DEFAULT_BACKGROUND_CONFIG };
  const color = normalizeHexColor(record.color);
  const imageUrl =
    typeof record.imageUrl === "string" && record.imageUrl.length > 0
      ? record.imageUrl
      : undefined;
  // Image mode without a usable source is meaningless — fall back to the shader.
  if (record.mode === "image" && imageUrl) {
    return { mode: "image", color, imageUrl };
  }
  // GLSL mode requires a plausible fragment source; a malformed/oversized/absent
  // source (or a hostile persisted value) falls back to the color field so a bad
  // shader can never wedge the background on load.
  if (record.mode === "glsl") {
    const shaderRecord = asRecord(record.shader);
    const source = shaderRecord?.source;
    if (isPlausibleFragmentSource(source)) {
      const presetId =
        typeof shaderRecord?.presetId === "string"
          ? shaderRecord.presetId
          : undefined;
      return {
        mode: "glsl",
        color,
        shader: {
          presetId,
          source,
          uniforms: normalizeUniforms(shaderRecord?.uniforms),
        },
      };
    }
    return { mode: "shader", color };
  }
  return { mode: "shader", color };
}

export function loadBackgroundConfig(): BackgroundConfig {
  return tryLocalStorage(
    () => {
      const raw = localStorage.getItem(UI_BACKGROUND_STORAGE_KEY);
      return raw
        ? normalizeBackgroundConfig(JSON.parse(raw))
        : { ...DEFAULT_BACKGROUND_CONFIG };
    },
    { ...DEFAULT_BACKGROUND_CONFIG },
  );
}

export function saveBackgroundConfig(config: BackgroundConfig): void {
  tryLocalStorage(() => {
    localStorage.setItem(
      UI_BACKGROUND_STORAGE_KEY,
      JSON.stringify(normalizeBackgroundConfig(config)),
    );
  }, undefined);
}

/**
 * Bounded undo history for the background. The most recent previous config is
 * last. Capped so a long session never grows localStorage without bound; image
 * configs carry a data/media URL so the cap is deliberately small.
 */
const UI_BACKGROUND_HISTORY_STORAGE_KEY = "eliza:ui-background-history";
/**
 * Data-URL image entries are the quota hazard: one downscaled photo is 1–4 MB
 * against localStorage's ~5 MB total, and `tryLocalStorage` swallows
 * QuotaExceededError — the write silently fails and the wallpaper reverts on
 * reload. Media-store (`/api/media/<hash>`) entries are tiny, so only inline
 * data URLs are capped: keep the single most recent one (uploads are re-hosted
 * to the media store on the primary path; a data URL only persists as the
 * offline fallback).
 */
export const MAX_BACKGROUND_HISTORY_DATA_URLS = 1;

export function normalizeBackgroundHistory(value: unknown): BackgroundConfig[] {
  if (!Array.isArray(value)) return [];
  const bounded = value
    .map((entry) => normalizeBackgroundConfig(entry))
    .slice(-MAX_BACKGROUND_HISTORY);
  let dataUrlBudget = MAX_BACKGROUND_HISTORY_DATA_URLS;
  const kept: BackgroundConfig[] = [];
  // Walk newest → oldest so the retained data-URL entry is the most recent.
  for (let i = bounded.length - 1; i >= 0; i--) {
    const entry = bounded[i];
    if (entry.imageUrl?.startsWith("data:")) {
      if (dataUrlBudget === 0) continue;
      dataUrlBudget--;
    }
    kept.unshift(entry);
  }
  return kept;
}

export function loadBackgroundHistory(): BackgroundConfig[] {
  return tryLocalStorage(() => {
    const raw = localStorage.getItem(UI_BACKGROUND_HISTORY_STORAGE_KEY);
    return raw ? normalizeBackgroundHistory(JSON.parse(raw)) : [];
  }, []);
}

export function saveBackgroundHistory(history: BackgroundConfig[]): void {
  tryLocalStorage(() => {
    localStorage.setItem(
      UI_BACKGROUND_HISTORY_STORAGE_KEY,
      JSON.stringify(normalizeBackgroundHistory(history)),
    );
  }, undefined);
}

// Redo stack (#10694) — persisted symmetrically with the undo history (the issue
// deliverable is "undo + redo, bounded, persisted") so "step forward" survives a
// reload just like "step back" does. Same bound + data-URL quota cap.
const UI_BACKGROUND_REDO_STORAGE_KEY = "eliza:ui-background-redo";

export function loadBackgroundRedo(): BackgroundConfig[] {
  return tryLocalStorage(() => {
    const raw = localStorage.getItem(UI_BACKGROUND_REDO_STORAGE_KEY);
    return raw ? normalizeBackgroundHistory(JSON.parse(raw)) : [];
  }, []);
}

export function saveBackgroundRedo(redo: BackgroundConfig[]): void {
  tryLocalStorage(() => {
    localStorage.setItem(
      UI_BACKGROUND_REDO_STORAGE_KEY,
      JSON.stringify(normalizeBackgroundHistory(redo)),
    );
  }, undefined);
}

/**
 * Apply the theme to the document root.
 * Sets both `data-theme` attribute and `.dark` class so both CSS selectors
 * in base.css (`[data-theme="dark"]` and `.dark`) are satisfied.
 */
export function applyUiTheme(theme: UiTheme): void {
  if (typeof document === "undefined") return;
  const normalizedTheme = normalizeUiTheme(theme);
  const root = document.documentElement;
  if (!root) return;
  const currentTheme =
    typeof root.getAttribute === "function"
      ? root.getAttribute("data-theme")
      : (root.dataset?.theme ?? null);
  const shouldBeDark = normalizedTheme === "dark";
  const classMatchesTheme = root.classList
    ? root.classList.contains("dark") === shouldBeDark
    : true;
  const colorSchemeMatches = root.style.colorScheme === normalizedTheme;

  const uiThemeChanged = !(
    currentTheme === normalizedTheme &&
    classMatchesTheme &&
    colorSchemeMatches
  );

  if (uiThemeChanged) {
    suppressThemeTransitions(root);

    if (currentTheme !== normalizedTheme) {
      if (typeof root.setAttribute === "function") {
        root.setAttribute("data-theme", normalizedTheme);
      } else if ("dataset" in root && root.dataset) {
        root.dataset.theme = normalizedTheme;
      } else {
        return;
      }
    }

    if (root.style && root.style.colorScheme !== normalizedTheme) {
      root.style.colorScheme = normalizedTheme;
    }

    if (root.classList && !classMatchesTheme) {
      if (shouldBeDark) {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }
    }
  }
}

/* ── Accent color persistence ─────────────────────────────────────────── */

const UI_ACCENT_STORAGE_KEY = "eliza:ui-accent";

/** Load the persisted accent preset id. Defaults to the brand accent. */
export function loadUiAccentId(): string {
  return tryLocalStorage(
    () => normalizeAccentId(localStorage.getItem(UI_ACCENT_STORAGE_KEY)),
    DEFAULT_ACCENT_ID,
  );
}

/** Persist the chosen accent preset id (normalized). */
export function saveUiAccentId(id: string): void {
  tryLocalStorage(() => {
    localStorage.setItem(UI_ACCENT_STORAGE_KEY, normalizeAccentId(id));
  }, undefined);
}

// The `--accent` family a user accent choice overrides. Applied as inline
// styles on <html> so they win over base.css and any host brand theme; the
// `default` accent clears them, restoring the brand accent.
const ACCENT_OVERRIDE_VARS = [
  "--accent",
  "--accent-rgb",
  "--accent-hover",
  "--accent-muted",
  "--accent-subtle",
  "--ring",
  "--border-hover",
  "--primary",
] as const;

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const int = Number.parseInt(m[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function mixChannel(channel: number, target: number, amount: number): number {
  return Math.round(channel + (target - channel) * amount);
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Apply a user-chosen accent color to the document root by overriding the
 * `--accent` family inline (so it wins over base.css / any host brand theme).
 * `null` (the `default` preset) clears the overrides, restoring the brand
 * accent. `--accent-foreground` is intentionally left untouched — every preset
 * is dark enough for the existing near-white foreground.
 */
export function applyUiAccent(color: string | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root?.style) return;
  const rgb = color == null ? null : hexToRgb(color);
  if (color == null || rgb == null) {
    for (const cssVar of ACCENT_OVERRIDE_VARS)
      root.style.removeProperty(cssVar);
    return;
  }
  const [r, g, b] = rgb;
  root.style.setProperty("--accent", color);
  root.style.setProperty("--accent-rgb", `${r}, ${g}, ${b}`);
  root.style.setProperty(
    "--accent-hover",
    rgbToHex(
      mixChannel(r, 255, 0.12),
      mixChannel(g, 255, 0.12),
      mixChannel(b, 255, 0.12),
    ),
  );
  root.style.setProperty(
    "--accent-muted",
    rgbToHex(
      mixChannel(r, 0, 0.18),
      mixChannel(g, 0, 0.18),
      mixChannel(b, 0, 0.18),
    ),
  );
  root.style.setProperty("--accent-subtle", `rgba(${r}, ${g}, ${b}, 0.14)`);
  root.style.setProperty("--ring", color);
  root.style.setProperty("--border-hover", color);
  root.style.setProperty("--primary", color);
}

const UI_LANGUAGE_STORAGE_KEY = "eliza:ui-language";
const UI_SHELL_MODE_STORAGE_KEY = "eliza:ui-shell-mode";
const LAST_NATIVE_TAB_STORAGE_KEY = "eliza:last-native-tab";
/* ── First-run completion persistence ────────────────────────────────── */

const FIRST_RUN_COMPLETE_STORAGE_KEY = "eliza:first-run-complete";

export function loadPersistedFirstRunComplete(): boolean {
  if (typeof localStorage === "undefined") {
    return false;
  }

  try {
    return localStorage.getItem(FIRST_RUN_COMPLETE_STORAGE_KEY) === "1";
  } catch (err) {
    // error-policy:J3 an unreadable store reads as "first run not complete";
    // the native-store mirror (hydratePersistedFirstRunCompleteFromNativeStore)
    // is the durability backstop against a wiped WebView store.
    logger.warn(
      `[persistence] failed to load first-run completion flag: ${describePersistenceError(err)}`,
    );
    return false;
  }
}

/**
 * Mirror the completion flag into the Capacitor Preferences native store
 * (Android SharedPreferences / iOS UserDefaults). WebView localStorage can be
 * cleared by the OS independently of app-scoped native storage; the native
 * mirror is what lets a WebView-storage wipe NOT re-trigger onboarding for an
 * already set-up install. No-op (and never throws) in web / unit-test shells
 * where Capacitor is unavailable. Mirrors the mobile-runtime-mode dual-write.
 */
async function persistNativeFirstRunComplete(complete: boolean): Promise<void> {
  try {
    const [{ Capacitor }, { Preferences }] = await Promise.all([
      import("@capacitor/core"),
      import("@capacitor/preferences"),
    ]);
    if (!Capacitor.isNativePlatform()) return;
    if (complete) {
      await Preferences.set({
        key: FIRST_RUN_COMPLETE_STORAGE_KEY,
        value: "1",
      });
    } else {
      await Preferences.remove({ key: FIRST_RUN_COMPLETE_STORAGE_KEY });
    }
  } catch {
    // error-policy:J4 Capacitor Preferences is unavailable in web / unit-test
    // shells; localStorage stays the sole store there by design.
  }
}

export function savePersistedFirstRunComplete(complete: boolean): void {
  void persistNativeFirstRunComplete(complete);

  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    if (complete) {
      localStorage.setItem(FIRST_RUN_COMPLETE_STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(FIRST_RUN_COMPLETE_STORAGE_KEY);
    }
  } catch (err) {
    logger.warn(
      `[persistence] failed to save first-run completion flag: ${describePersistenceError(err)}`,
    );
  }
}

/**
 * Boot-time durability restore for the onboarding-complete flag (issue #11506).
 *
 * Android/iOS can clear a WebView's localStorage independently of the app's
 * Capacitor Preferences store, which would drop `eliza:first-run-complete` and
 * re-show onboarding on the next launch even though the agent config on disk is
 * intact. Completion is mirrored into Preferences on save; on boot, when the
 * WebView lost the localStorage flag but the durable native store still has it,
 * restore the localStorage value so the synchronous boot readers
 * (`loadPersistedFirstRunComplete` in restore, the lifecycle-state init, and
 * the first-run completion ref) see the completed state and route straight
 * home instead of re-prompting.
 *
 * Awaited early in the restoring-session phase (before `hadPrior` is read), so
 * the restore repopulates localStorage on the SAME boot. No-op when
 * localStorage already carries the flag or Capacitor is unavailable.
 */
export async function hydratePersistedFirstRunCompleteFromNativeStore(): Promise<void> {
  if (typeof localStorage === "undefined") return;
  if (loadPersistedFirstRunComplete()) return;

  try {
    const [{ Capacitor }, { Preferences }] = await Promise.all([
      import("@capacitor/core"),
      import("@capacitor/preferences"),
    ]);
    if (!Capacitor.isNativePlatform()) return;
    const { value } = await Preferences.get({
      key: FIRST_RUN_COMPLETE_STORAGE_KEY,
    });
    if (value === "1") {
      localStorage.setItem(FIRST_RUN_COMPLETE_STORAGE_KEY, "1");
    }
  } catch {
    // error-policy:J4 native store unavailable — localStorage remains
    // authoritative for this boot.
  }
}

/* ── Content pack persistence ───────────────────────────────────────── */

const ACTIVE_PACK_STORAGE_KEY = "elizaos:active-pack-id";
const ACTIVE_PACK_URL_STORAGE_KEY = "elizaos:active-pack-url";

export function loadPersistedActivePackId(): string | null {
  return tryLocalStorage(
    () => localStorage.getItem(ACTIVE_PACK_STORAGE_KEY),
    null,
  );
}

export function savePersistedActivePackId(packId: string | null): void {
  tryLocalStorage(() => {
    if (packId) {
      localStorage.setItem(ACTIVE_PACK_STORAGE_KEY, packId);
    } else {
      localStorage.removeItem(ACTIVE_PACK_STORAGE_KEY);
    }
  }, undefined);
}

export function loadPersistedActivePackUrl(): string | null {
  return tryLocalStorage(
    () => localStorage.getItem(ACTIVE_PACK_URL_STORAGE_KEY),
    null,
  );
}

export function savePersistedActivePackUrl(packUrl: string | null): void {
  tryLocalStorage(() => {
    if (packUrl) {
      localStorage.setItem(ACTIVE_PACK_URL_STORAGE_KEY, packUrl);
    } else {
      localStorage.removeItem(ACTIVE_PACK_URL_STORAGE_KEY);
    }
  }, undefined);
}

export function loadUiLanguage(): UiLanguage {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
    if (stored != null) return normalizeLanguage(stored);
    // No explicit user choice yet — guess from browser/region hints.
    return detectClientLanguage() ?? DEFAULT_UI_LANGUAGE;
  }, DEFAULT_UI_LANGUAGE);
}

export function saveUiLanguage(language: UiLanguage): void {
  tryLocalStorage(() => {
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, normalizeLanguage(language));
  }, undefined);
}

/** Whether the user has a persisted UI language (vs. a fresh first visit). */
export function hasStoredUiLanguage(): boolean {
  return tryLocalStorage(
    () => localStorage.getItem(UI_LANGUAGE_STORAGE_KEY) != null,
    false,
  );
}

function normalizeUiShellMode(_mode: unknown): UiShellMode {
  return "native";
}

export { normalizeUiShellMode };

export function loadUiShellMode(): UiShellMode {
  return tryLocalStorage(
    () => normalizeUiShellMode(localStorage.getItem(UI_SHELL_MODE_STORAGE_KEY)),
    "native",
  );
}

export function saveUiShellMode(mode: UiShellMode): void {
  tryLocalStorage(() => {
    localStorage.setItem(UI_SHELL_MODE_STORAGE_KEY, normalizeUiShellMode(mode));
  }, undefined);
}

function normalizeLastNativeTab(tab: unknown): Tab {
  switch (tab) {
    case "advanced":
      return "fine-tuning";
    case "chat":
    case "stream":
    case "apps":
    case "browser":
    case "inventory":
    case "documents":
    case "triggers":
    case "plugins":
    case "skills":
    case "fine-tuning":
    case "trajectories":
    case "relationships":
    case "voice":
    case "runtime":
    case "database":
    case "desktop":
    case "settings":
    case "logs":
      return tab;
    default:
      return "chat";
  }
}

export function loadLastNativeTab(): Tab {
  return tryLocalStorage(
    () =>
      normalizeLastNativeTab(localStorage.getItem(LAST_NATIVE_TAB_STORAGE_KEY)),
    "chat",
  );
}

export function saveLastNativeTab(tab: Tab): void {
  tryLocalStorage(() => {
    localStorage.setItem(
      LAST_NATIVE_TAB_STORAGE_KEY,
      normalizeLastNativeTab(tab),
    );
  }, undefined);
}

/* ── Avatar persistence ───────────────────────────────────────────────── */
const AVATAR_INDEX_KEY = "eliza_avatar_index";

export function loadAvatarIndex(): number {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(AVATAR_INDEX_KEY);
    if (stored) {
      const n = parseInt(stored, 10);
      return normalizeAvatarIndex(n);
    }
    return 1;
  }, 1);
}

export function saveAvatarIndex(index: number): void {
  tryLocalStorage(() => {
    localStorage.setItem(AVATAR_INDEX_KEY, String(normalizeAvatarIndex(index)));
  }, undefined);
}

export function clearAvatarIndex(): void {
  tryLocalStorage(() => {
    localStorage.removeItem(AVATAR_INDEX_KEY);
  }, undefined);
}

/* ── Favorite apps persistence ────────────────────────────────────────── */
const FAVORITE_APPS_KEY = "eliza:favorite-apps";

function sanitizeFavoriteApps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const apps: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || seen.has(item)) {
      continue;
    }
    seen.add(item);
    apps.push(item);
  }
  return apps;
}

function getDefaultFavoriteApps(): string[] {
  return sanitizeFavoriteApps(getBootConfig().defaultApps);
}

export function loadFavoriteApps(): string[] {
  const defaultApps = getDefaultFavoriteApps();
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(FAVORITE_APPS_KEY);
    if (stored === null) return defaultApps;
    try {
      const parsed = JSON.parse(stored);
      return sanitizeFavoriteApps(parsed);
    } catch (err) {
      // error-policy:J3 corrupt saved favorites start clean from the defaults
      // (documented start-clean parse; the warn keeps corruption observable).
      logger.warn(
        `[persistence] failed to parse favorite apps from localStorage: ${describePersistenceError(err)}`,
      );
      return defaultApps;
    }
  }, defaultApps);
}

export function saveFavoriteApps(apps: string[]): void {
  tryLocalStorage(() => {
    localStorage.setItem(
      FAVORITE_APPS_KEY,
      JSON.stringify(sanitizeFavoriteApps(apps)),
    );
  }, undefined);
}

/**
 * Hydrate the favorites list from the server-side persisted store
 * (config.ui.favoriteApps), falling back to the local cache on failure.
 * Mirrors the result back into localStorage so the next boot is fast.
 *
 * During iOS boot the native transport can be legitimately mode-gated (cloud
 * builds reject local-agent IPC until runtime-mode reconciliation finishes) —
 * that is an expected startup phase, not a broken pipeline, so it logs at
 * debug level; `useAppShellState` re-fetches once after the agent-ready
 * event. Every other failure still warns.
 */
export async function fetchServerFavoriteApps(): Promise<string[] | null> {
  try {
    const resp = await fetchWithCsrf("/api/apps/favorites", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { favoriteApps?: unknown };
    const sanitized = sanitizeFavoriteApps(data.favoriteApps);
    saveFavoriteApps(sanitized);
    return sanitized;
  } catch (err) {
    const message = describePersistenceError(err);
    // error-policy:J4 `null` is the documented failure signal (caller keeps
    // the local cache); iOS mode-gated boot logs debug, real failures warn.
    if (isTerminalIosNativeAgentBootErrorMessage(message)) {
      logger.debug(
        `[persistence] server favorite apps unavailable while the native transport is mode-gated (will retry after agent-ready): ${message}`,
      );
      return null;
    }
    logger.warn(
      `[persistence] failed to fetch server favorite apps: ${message}`,
    );
    return null;
  }
}

/**
 * Replace the server-persisted favorites list. Used when the UI commits
 * a bulk reorder/edit. Best-effort: returns null on failure.
 */
export async function replaceServerFavoriteApps(
  favoriteAppNames: string[],
): Promise<string[] | null> {
  try {
    const resp = await fetchWithCsrf("/api/apps/favorites/replace", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ favoriteAppNames }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { favoriteApps?: unknown };
    const sanitized = sanitizeFavoriteApps(data.favoriteApps);
    saveFavoriteApps(sanitized);
    return sanitized;
  } catch (err) {
    // error-policy:J4 `null` is the documented failure signal — the caller
    // keeps its optimistic UI state; the warn keeps a broken route observable.
    logger.warn(
      `[persistence] failed to replace server favorite apps: ${describePersistenceError(err)}`,
    );
    return null;
  }
}

/**
 * Toggle a single app's favorite state on the server. Returns the updated
 * list, or `null` if the request failed (caller should keep optimistic UI
 * state). Local cache is updated on success.
 */
export async function toggleServerFavoriteApp(
  appName: string,
  isFavorite: boolean,
): Promise<string[] | null> {
  try {
    const resp = await fetchWithCsrf("/api/apps/favorites", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appName, isFavorite }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { favoriteApps?: unknown };
    const sanitized = sanitizeFavoriteApps(data.favoriteApps);
    saveFavoriteApps(sanitized);
    return sanitized;
  } catch (err) {
    // error-policy:J4 `null` is the documented failure signal — the caller
    // keeps its optimistic UI state; the warn keeps a broken route observable.
    logger.warn(
      `[persistence] failed to toggle server favorite app: ${describePersistenceError(err)}`,
    );
    return null;
  }
}

/* ── Recent apps persistence ──────────────────────────────────────────── */
const RECENT_APPS_KEY = "eliza:recent-apps";
/** Cap on persisted recency list. Older entries are evicted. */
export const RECENT_APPS_MAX = 10;

export function loadRecentApps(): string[] {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(RECENT_APPS_KEY);
    if (!stored) return [];
    try {
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((item): item is string => typeof item === "string")
        .slice(0, RECENT_APPS_MAX);
    } catch (err) {
      // error-policy:J3 corrupt saved recents start clean; warn keeps the
      // corruption observable.
      logger.warn(
        `[persistence] failed to parse recent apps from localStorage: ${describePersistenceError(err)}`,
      );
      return [];
    }
  }, []);
}

export function saveRecentApps(apps: string[]): void {
  tryLocalStorage(() => {
    localStorage.setItem(
      RECENT_APPS_KEY,
      JSON.stringify(apps.slice(0, RECENT_APPS_MAX)),
    );
  }, undefined);
}

/* ── Launcher recents/favorites persistence ─────────────────────────── */
// The launcher's Recents/Favorites zones are keyed by canonical LAUNCHER VIEW
// ID (`wallet`, `settings`, …), a different namespace from the catalog-app-name
// keyed `recent-apps`/`favorite-apps` above (which the chat + catalog surfaces
// own). They are kept separate so a launcher tap never rewrites the catalog's
// app-name lists and vice versa — merging the two would conflate unlike keys.
const LAUNCHER_RECENTS_KEY = "eliza:launcher:recents";
const LAUNCHER_FAVORITES_KEY = "eliza:launcher:favorites";
/** Cap on the persisted launcher recents list; older ids are evicted. */
export const LAUNCHER_RECENTS_MAX = 8;

function loadLauncherIds(key: string, max: number): string[] {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(key);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .slice(0, max);
  }, []);
}

export function loadLauncherRecents(): string[] {
  return loadLauncherIds(LAUNCHER_RECENTS_KEY, LAUNCHER_RECENTS_MAX);
}

export function saveLauncherRecents(ids: string[]): void {
  tryLocalStorage(() => {
    localStorage.setItem(
      LAUNCHER_RECENTS_KEY,
      JSON.stringify(ids.slice(0, LAUNCHER_RECENTS_MAX)),
    );
  }, undefined);
}

export function loadLauncherFavorites(): string[] {
  return loadLauncherIds(LAUNCHER_FAVORITES_KEY, Number.MAX_SAFE_INTEGER);
}

export function saveLauncherFavorites(ids: string[]): void {
  tryLocalStorage(() => {
    localStorage.setItem(LAUNCHER_FAVORITES_KEY, JSON.stringify(ids));
  }, undefined);
}

/**
 * Move `id` to the front of the launcher recents list and persist it. Pure
 * most-recent-first ordering with de-dup and eviction; returns the new list so
 * the caller can update React state without a second read.
 */
export function recordLauncherRecent(id: string): string[] {
  const next = [id, ...loadLauncherRecents().filter((x) => x !== id)].slice(
    0,
    LAUNCHER_RECENTS_MAX,
  );
  saveLauncherRecents(next);
  return next;
}

/* ── Wallet enabled persistence ─────────────────────────────────────── */
const WALLET_ENABLED_KEY = "eliza:wallet:enabled";

export function loadWalletEnabled(): boolean {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(WALLET_ENABLED_KEY);
    return stored === null ? true : stored === "true";
  }, true);
}

export function saveWalletEnabled(value: boolean): void {
  tryLocalStorage(() => {
    localStorage.setItem(WALLET_ENABLED_KEY, String(value));
  }, undefined);
}

/* ── Continuous chat mode persistence ───────────────────────────────────── */
const CONTINUOUS_CHAT_MODE_KEY = "eliza:voice:continuous-chat-mode";
type ContinuousChatModeValue = "off" | "vad-gated" | "always-on";

function normalizeContinuousChatMode(value: unknown): ContinuousChatModeValue {
  if (value === "vad-gated" || value === "always-on") return value;
  return "off";
}

export function loadContinuousChatMode(): ContinuousChatModeValue {
  return tryLocalStorage(
    () =>
      normalizeContinuousChatMode(
        localStorage.getItem(CONTINUOUS_CHAT_MODE_KEY),
      ),
    "off",
  );
}

export function saveContinuousChatMode(mode: ContinuousChatModeValue): void {
  tryLocalStorage(() => {
    localStorage.setItem(CONTINUOUS_CHAT_MODE_KEY, mode);
  }, undefined);
}

/* ── Wake-word listening persistence ────────────────────────────────────── */
// Device-local master switch for the "hey <name>" wake-word listening window
// (see useWakeListenWindow). Stored here — not under `messages.voice` — because
// it gates a device-local capture loop the shell reads synchronously on render,
// the same dual-store pattern continuous-chat-mode and vad-auto-stop use. It
// defaults ON so existing installs keep the always-available wake entry ramp;
// the Settings → Voice toggle is what lets a user turn it off.
const WAKE_WORD_ENABLED_KEY = "eliza:voice:wake-word-enabled";

export function loadWakeWordEnabled(): boolean {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(WAKE_WORD_ENABLED_KEY);
    return stored === null ? true : stored === "true";
  }, true);
}

export function saveWakeWordEnabled(value: boolean): void {
  tryLocalStorage(() => {
    localStorage.setItem(WAKE_WORD_ENABLED_KEY, String(value));
  }, undefined);
}

/* ── VAD auto-stop persistence ──────────────────────────────────────────── */
// Local mirror of the `vadAutoStop` voice setting (source of truth is the agent
// config under `messages.voice`). Stored here too so the capture hot path
// (`useShellController.startCapture`) can read it synchronously on the user
// gesture without an async config fetch — mirrors how continuous-chat-mode is
// dual-stored above.
const VAD_AUTO_STOP_KEY = "eliza:voice:vad-auto-stop";

export interface VadAutoStopValue {
  /** Trailing silence (ms) that ends a turn in local-ASR capture. */
  silenceMs: number;
  /** RMS amplitude (0–1) above which audio is treated as speech. */
  speechRmsThreshold: number;
}

const DEFAULT_VAD_AUTO_STOP: VadAutoStopValue = {
  silenceMs: DEFAULT_LOCAL_ASR_AUTO_STOP.silenceMs,
  speechRmsThreshold: DEFAULT_LOCAL_ASR_AUTO_STOP.speechRmsThreshold,
};

export function loadVadAutoStop(): VadAutoStopValue {
  return tryLocalStorage(() => {
    const raw = localStorage.getItem(VAD_AUTO_STOP_KEY);
    if (!raw) return DEFAULT_VAD_AUTO_STOP;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      silenceMs:
        typeof parsed.silenceMs === "number" &&
        Number.isFinite(parsed.silenceMs)
          ? parsed.silenceMs
          : DEFAULT_VAD_AUTO_STOP.silenceMs,
      speechRmsThreshold:
        typeof parsed.speechRmsThreshold === "number" &&
        Number.isFinite(parsed.speechRmsThreshold)
          ? parsed.speechRmsThreshold
          : DEFAULT_VAD_AUTO_STOP.speechRmsThreshold,
    };
  }, DEFAULT_VAD_AUTO_STOP);
}

export function saveVadAutoStop(value: VadAutoStopValue): void {
  tryLocalStorage(() => {
    localStorage.setItem(VAD_AUTO_STOP_KEY, JSON.stringify(value));
  }, undefined);
}

/* ── Browser enabled persistence ────────────────────────────────────── */
const BROWSER_ENABLED_KEY = "eliza:browser:enabled";

export function loadBrowserEnabled(): boolean {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(BROWSER_ENABLED_KEY);
    return stored === null ? true : stored === "true";
  }, true);
}

export function saveBrowserEnabled(value: boolean): void {
  tryLocalStorage(() => {
    localStorage.setItem(BROWSER_ENABLED_KEY, String(value));
  }, undefined);
}

/* ── Computer Use enabled persistence ───────────────────────────────── */
const COMPUTER_USE_ENABLED_KEY = "eliza:computeruse:enabled";

export function loadComputerUseEnabled(): boolean {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(COMPUTER_USE_ENABLED_KEY);
    return stored === null ? false : stored === "true";
  }, false);
}

export function saveComputerUseEnabled(value: boolean): void {
  tryLocalStorage(() => {
    localStorage.setItem(COMPUTER_USE_ENABLED_KEY, String(value));
  }, undefined);
}

/* ── Chat UI persistence ──────────────────────────────────────────────── */
const CHAT_AVATAR_VISIBLE_KEY = "eliza:chat:avatarVisible";
const CHAT_VOICE_MUTED_KEY = "eliza:chat:voiceMuted";

export function loadChatAvatarVisible(): boolean {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(CHAT_AVATAR_VISIBLE_KEY);
    return stored === null ? true : stored === "true";
  }, true);
}

export function loadChatVoiceMuted(): boolean {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(CHAT_VOICE_MUTED_KEY);
    return stored === null ? false : stored === "true";
  }, false);
}

export function saveChatAvatarVisible(value: boolean): void {
  tryLocalStorage(() => {
    localStorage.setItem(CHAT_AVATAR_VISIBLE_KEY, String(value));
  }, undefined);
}

export function saveChatVoiceMuted(value: boolean): void {
  tryLocalStorage(() => {
    localStorage.setItem(CHAT_VOICE_MUTED_KEY, String(value));
  }, undefined);
}

const ACTIVE_CONVERSATION_ID_KEY = "eliza:chat:activeConversationId";
const COMPANION_MESSAGE_CUTOFF_TS_KEY = "eliza:chat:companionMessageCutoffTs";

export function loadActiveConversationId(): string | null {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(ACTIVE_CONVERSATION_ID_KEY)?.trim();
    return stored ? stored : null;
  }, null);
}

export function saveActiveConversationId(value: string | null): void {
  tryLocalStorage(() => {
    if (value?.trim()) {
      localStorage.setItem(ACTIVE_CONVERSATION_ID_KEY, value);
      return;
    }
    localStorage.removeItem(ACTIVE_CONVERSATION_ID_KEY);
  }, undefined);
}

export function loadCompanionMessageCutoffTs(): number {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(COMPANION_MESSAGE_CUTOFF_TS_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }, 0);
}

export function saveCompanionMessageCutoffTs(value: number): void {
  tryLocalStorage(() => {
    localStorage.setItem(
      COMPANION_MESSAGE_CUTOFF_TS_KEY,
      String(Math.max(0, Math.trunc(value))),
    );
  }, undefined);
}

export interface PersistedActiveServer {
  /** Stable identifier for the selected server target. */
  id: string;
  /** Server category as seen by the client startup flow. */
  kind: "local" | "cloud" | "remote";
  /** Human-readable label for future chooser/history UI. */
  label: string;
  /** Reachable API base for remote/cloud servers. */
  apiBase?: string;
  /** Optional auth/access token for the selected server. */
  accessToken?: string;
}

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";
const ELIZA_CLOUD_CONTROL_PLANE_HOSTS = new Set([
  "api.elizacloud.ai",
  "elizacloud.ai",
  "www.elizacloud.ai",
  "dev.elizacloud.ai",
]);

function trimPersistedValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeApiBase(value: unknown): string | undefined {
  const trimmed = trimPersistedValue(value);
  if (!trimmed) return trimmed;
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 47) end--;
  return normalizeDirectCloudSharedAgentApiBase(trimmed.slice(0, end));
}

function isElizaCloudControlPlaneApiBase(value: unknown): boolean {
  const apiBase = normalizeApiBase(value);
  if (!apiBase) return false;
  try {
    const url = new URL(apiBase);
    if (!ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has(url.hostname.toLowerCase())) {
      return false;
    }
    // The BARE control-plane origin (no path) AND the agent-id-less agents
    // COLLECTION (`/api/v1/eliza/agents`, no `/<id>`) are both "managed cloud"
    // endpoints with no agent selected — their apiBase is derived at runtime and
    // must NOT be persisted (persisting the id-less collection makes every
    // /api/* call concat to `.../agents/api/...` and 404 with "Backend
    // Unreachable"). A specific per-agent base on the same host — a shared-runtime
    // REST adapter at /api/v1/eliza/agents/<id> — IS concrete and MUST be
    // persisted; dropping it loses the agent the client must talk to. Treat any
    // other non-trivial path as concrete.
    const pathname = url.pathname.replace(/\/+$/, "");
    return pathname === "" || pathname === "/api/v1/eliza/agents";
  } catch (err) {
    // error-policy:J3 an unparseable apiBase is not a control-plane base;
    // downstream trust gates reject it on their own.
    logger.debug(
      `[persistence] failed to parse apiBase URL while checking Eliza Cloud control plane: apiBase=${apiBase}; error=${describePersistenceError(err)}`,
    );
    return false;
  }
}

export function createPersistedActiveServer(args: {
  kind: PersistedActiveServer["kind"];
  id?: string;
  apiBase?: string;
  accessToken?: string;
  label?: string;
}): PersistedActiveServer {
  const normalizedApiBase = normalizeApiBase(args.apiBase);
  const apiBase = isElizaCloudControlPlaneApiBase(normalizedApiBase)
    ? undefined
    : normalizedApiBase;
  const accessToken = trimPersistedValue(args.accessToken);
  const explicitLabel = trimPersistedValue(args.label);

  switch (args.kind) {
    case "local":
      return {
        id: "local:embedded",
        kind: "local",
        label: explicitLabel ?? "This device",
      };
    case "cloud":
      return {
        id: trimPersistedValue(args.id) ?? `cloud:${apiBase ?? "managed"}`,
        kind: "cloud",
        label: explicitLabel ?? "Eliza Cloud",
        ...(apiBase ? { apiBase } : {}),
        ...(accessToken ? { accessToken } : {}),
      };
    case "remote": {
      let label = explicitLabel ?? "Remote server";
      if (!explicitLabel && apiBase) {
        try {
          label = new URL(apiBase).host || label;
        } catch (err) {
          // error-policy:J3 label derivation only — an unparseable base keeps
          // the raw string as the display label.
          logger.debug(
            `[persistence] failed to parse apiBase URL for remote server label; using raw apiBase: apiBase=${apiBase}; error=${describePersistenceError(err)}`,
          );
          label = apiBase;
        }
      }
      return {
        id: `remote:${apiBase ?? "manual"}`,
        kind: "remote",
        label,
        ...(apiBase ? { apiBase } : {}),
        ...(accessToken ? { accessToken } : {}),
      };
    }
  }
}

function normalizePersistedActiveServer(
  value: unknown,
): PersistedActiveServer | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const kind =
    record.kind === "local" ||
    record.kind === "cloud" ||
    record.kind === "remote"
      ? record.kind
      : null;
  const id = trimPersistedValue(record.id);
  const label = trimPersistedValue(record.label);
  if (!kind || !id || !label) {
    return null;
  }

  const normalizedApiBase = normalizeApiBase(record.apiBase);
  const apiBase = isElizaCloudControlPlaneApiBase(normalizedApiBase)
    ? undefined
    : normalizedApiBase;
  const accessToken = trimPersistedValue(record.accessToken);

  return {
    id,
    kind,
    label,
    ...(apiBase ? { apiBase } : {}),
    ...(accessToken ? { accessToken } : {}),
  };
}

export function loadPersistedActiveServer(): PersistedActiveServer | null {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(ACTIVE_SERVER_STORAGE_KEY);
    if (!stored) {
      return null;
    }
    return normalizePersistedActiveServer(JSON.parse(stored));
  }, null);
}

export function savePersistedActiveServer(server: PersistedActiveServer): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  // The active-server record carries the sign-in state (kind/apiBase/token) and
  // the backend the app reconnects to. A swallowed persist failure (quota,
  // private-mode SecurityError) silently loses a freshly-recovered apiBase, so
  // backfillCloudApiBase re-runs every boot with no diagnostic. Mirror
  // savePersistedFirstRunComplete: still no-throw + no-op when unavailable, but
  // surface the failure instead of swallowing it.
  try {
    localStorage.setItem(ACTIVE_SERVER_STORAGE_KEY, JSON.stringify(server));
  } catch (err) {
    // error-policy:J4 documented above — no-throw persistence write with the
    // failure surfaced at warn instead of swallowed.
    logger.warn(
      `[persistence] failed to save active server: ${describePersistenceError(err)}`,
    );
  }
}

export function clearPersistedActiveServer(): void {
  tryLocalStorage(() => {
    localStorage.removeItem(ACTIVE_SERVER_STORAGE_KEY);
  }, undefined);
}

/**
 * Drop the bearer access token from the persisted active server while keeping
 * the server selection (kind/apiBase/label). Call this on sign-out: the token
 * is a JWT and leaving it in localStorage after sign-out is an at-rest leak,
 * but clearing the whole record would needlessly forget which backend to
 * re-authenticate against.
 */
export function scrubPersistedActiveServerToken(): void {
  const current = loadPersistedActiveServer();
  if (!current?.accessToken) return;
  const scrubbed = { ...current };
  delete scrubbed.accessToken;
  savePersistedActiveServer(scrubbed);
}
