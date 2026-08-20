/**
 * localStorage + server persistence for shell state: the active-server record,
 * UI language, favorite/recent apps, and background config/history. The single
 * read/write layer the state modules go through.
 */
import { logger } from "@elizaos/logger";
import { asRecord } from "@elizaos/shared";
import { fetchWithCsrf } from "../api/csrf-client";
import { isTerminalIosNativeAgentBootErrorMessage } from "../api/ios-local-agent-transport";
import { getShaderPreset } from "../backgrounds/shader-presets";
import {
  isPlausibleFragmentSource,
  normalizeUniforms,
} from "../backgrounds/shader-schema";
import { isElectrobunRuntime } from "../bridge/electrobun-runtime";
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
import { shellLocalStorage } from "../surface-realm-channel";
import {
  ELIZA_CLOUD_CONTROL_PLANE_HOSTS,
  isManagedCloudSharedAgentBase,
  normalizeDirectCloudSharedAgentApiBase,
} from "../utils/cloud-agent-base";
import { DEFAULT_LOCAL_ASR_AUTO_STOP } from "../voice/local-asr-capture";
import {
  type ContinuousChatModeValue,
  resolveContinuousChatMode,
} from "./continuous-chat-mode";
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
const APP_UI_THEME: UiTheme = "dark";
const APP_UI_THEME_MODE: UiThemeMode = APP_UI_THEME;

function normalizeUiThemeMode(_value: unknown): UiThemeMode {
  return APP_UI_THEME_MODE;
}

export { normalizeUiThemeMode };

/**
 * The app shell has one curated dark appearance. Keep this compatibility
 * function for consumers of the preference API, but never inherit OS chrome.
 */
export function getSystemTheme(): UiTheme {
  return APP_UI_THEME;
}

/**
 * Resolve any legacy theme mode to the app's single supported appearance.
 */
export function resolveUiTheme(_mode: UiThemeMode): UiTheme {
  return APP_UI_THEME;
}

/**
 * Return the supported theme mode regardless of any legacy persisted value.
 */
export function loadUiThemeMode(): UiThemeMode {
  return APP_UI_THEME_MODE;
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
    shellLocalStorage.setItem(
      HOME_TIME_WIDGET_HIDDEN_STORAGE_KEY,
      hidden ? "1" : "0",
    );
  }, undefined);
}

export function saveUiThemeMode(mode: UiThemeMode): void {
  tryLocalStorage(() => {
    shellLocalStorage.setItem(
      UI_THEME_MODE_STORAGE_KEY,
      normalizeUiThemeMode(mode),
    );
  }, undefined);
}
const THEME_SWITCHING_ATTRIBUTE = "data-theme-switching";
let themeSwitchResetFrameId: number | null = null;

function normalizeUiTheme(_value: unknown): UiTheme {
  return APP_UI_THEME;
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
    shellLocalStorage.setItem(UI_THEME_STORAGE_KEY, normalized);
    shellLocalStorage.setItem(LEGACY_UI_THEME_STORAGE_KEY, normalized);
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

// Renamed/recompressed curated wallpapers whose OLD URL may still sit in a
// user's persisted background config. The asset is gone from /public, so
// without this read-time alias every install that saved the old default 404s
// its wallpaper after the deploy (#15184 removed bg-sunset.jpg). Normalization
// runs on both load and save, so persisted configs self-heal on first touch.
const LEGACY_WALLPAPER_ALIASES: Record<string, string> = {
  "/bg-sunset.jpg": "/bg-sunset.webp",
};

export function normalizeBackgroundConfig(value: unknown): BackgroundConfig {
  const record = asRecord(value);
  if (!record) return { ...DEFAULT_BACKGROUND_CONFIG };
  const color = normalizeHexColor(record.color);
  const rawImageUrl =
    typeof record.imageUrl === "string" && record.imageUrl.length > 0
      ? record.imageUrl
      : undefined;
  const imageUrl = rawImageUrl
    ? (LEGACY_WALLPAPER_ALIASES[rawImageUrl] ?? rawImageUrl)
    : undefined;
  // Image mode without a usable source is meaningless — fall back to the shader.
  if (record.mode === "image" && imageUrl) {
    return { mode: "image", color, imageUrl };
  }
  // Persisted GLSL is a preset capability, not an arbitrary source channel.
  // Resolve the id back to the compiled-in corpus so a hand-edited localStorage
  // source cannot reach WebGL and an older saved preset self-heals after updates.
  if (record.mode === "glsl") {
    const shaderRecord = asRecord(record.shader);
    const preset = getShaderPreset(
      typeof shaderRecord?.presetId === "string"
        ? shaderRecord.presetId
        : undefined,
    );
    if (preset && isPlausibleFragmentSource(preset.source)) {
      return {
        mode: "glsl",
        color,
        shader: {
          presetId: preset.id,
          source: preset.source,
          uniforms: normalizeUniforms(shaderRecord?.uniforms),
        },
      };
    }
    return { mode: "shader", color };
  }
  return { mode: "shader", color };
}

// Early builds eagerly persisted untouched fresh state as the exact black
// shader shape, making it indistinguishable from an intentional selection.
// This flag permits one safe normalization of that shape. Wallpaper records
// are never remapped because they lack selected-vs-default provenance.
const UI_BACKGROUND_DEFAULT_MIGRATION_KEY = "eliza:ui-background-default-v2";

export function loadBackgroundConfig(): BackgroundConfig {
  return tryLocalStorage(
    () => {
      const raw = localStorage.getItem(UI_BACKGROUND_STORAGE_KEY);
      const migrated = localStorage.getItem(
        UI_BACKGROUND_DEFAULT_MIGRATION_KEY,
      );
      if (!migrated) {
        // Stamping before a future selection preserves deliberate black-shader
        // choices while keeping the normalization one-shot.
        shellLocalStorage.setItem(UI_BACKGROUND_DEFAULT_MIGRATION_KEY, "1");
      }
      if (!raw) return { ...DEFAULT_BACKGROUND_CONFIG };
      const config = normalizeBackgroundConfig(JSON.parse(raw));
      if (
        !migrated &&
        config.mode === "shader" &&
        config.color === DEFAULT_BACKGROUND_COLOR
      ) {
        return { ...DEFAULT_BACKGROUND_CONFIG };
      }
      return config;
    },
    { ...DEFAULT_BACKGROUND_CONFIG },
  );
}

export function saveBackgroundConfig(config: BackgroundConfig): void {
  tryLocalStorage(() => {
    shellLocalStorage.setItem(
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
    shellLocalStorage.setItem(
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
    shellLocalStorage.setItem(
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
    shellLocalStorage.setItem(UI_ACCENT_STORAGE_KEY, normalizeAccentId(id));
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
const CLOUD_ONLY_FIRST_RUN_COMPLETE_STORAGE_KEY =
  "eliza:first-run-complete:cloud-only:v1";

/**
 * Keep completion proof scoped to the onboarding contract that produced it.
 * Desktop release channels intentionally share a WebKit container when their
 * bundle id is the same, so an unscoped completion bit from a local-capable
 * build must never suppress Cloud sign-in in a later cloud-only build.
 */
function firstRunCompleteStorageKey(cloudOnly?: boolean): string {
  return (cloudOnly ?? getBootConfig().branding.cloudOnly) === true
    ? CLOUD_ONLY_FIRST_RUN_COMPLETE_STORAGE_KEY
    : FIRST_RUN_COMPLETE_STORAGE_KEY;
}

export function loadPersistedFirstRunComplete(cloudOnly?: boolean): boolean {
  if (typeof localStorage === "undefined") {
    return false;
  }

  try {
    return localStorage.getItem(firstRunCompleteStorageKey(cloudOnly)) === "1";
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
  const storageKey = firstRunCompleteStorageKey();
  try {
    const [{ Capacitor }, { Preferences }] = await Promise.all([
      import("@capacitor/core"),
      import("@capacitor/preferences"),
    ]);
    if (!Capacitor.isNativePlatform()) return;
    if (complete) {
      await Preferences.set({
        key: storageKey,
        value: "1",
      });
    } else {
      await Preferences.remove({ key: storageKey });
    }
  } catch {
    // error-policy:J4 Capacitor Preferences is unavailable in web / unit-test
    // shells; localStorage stays the sole store there by design.
  }
}

export function savePersistedFirstRunComplete(complete: boolean): void {
  const storageKey = firstRunCompleteStorageKey();
  void persistNativeFirstRunComplete(complete);

  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    if (complete) {
      shellLocalStorage.setItem(storageKey, "1");
    } else {
      shellLocalStorage.removeItem(storageKey);
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
 * Capacitor Preferences store, which would drop the scoped completion key and
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
  const storageKey = firstRunCompleteStorageKey();

  try {
    const [{ Capacitor }, { Preferences }] = await Promise.all([
      import("@capacitor/core"),
      import("@capacitor/preferences"),
    ]);
    if (!Capacitor.isNativePlatform()) return;
    const { value } = await Preferences.get({
      key: storageKey,
    });
    if (value === "1") {
      shellLocalStorage.setItem(storageKey, "1");
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
      shellLocalStorage.setItem(ACTIVE_PACK_STORAGE_KEY, packId);
    } else {
      shellLocalStorage.removeItem(ACTIVE_PACK_STORAGE_KEY);
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
      shellLocalStorage.setItem(ACTIVE_PACK_URL_STORAGE_KEY, packUrl);
    } else {
      shellLocalStorage.removeItem(ACTIVE_PACK_URL_STORAGE_KEY);
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
    shellLocalStorage.setItem(
      UI_LANGUAGE_STORAGE_KEY,
      normalizeLanguage(language),
    );
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
    shellLocalStorage.setItem(
      UI_SHELL_MODE_STORAGE_KEY,
      normalizeUiShellMode(mode),
    );
  }, undefined);
}

function normalizeLastNativeTab(tab: unknown): Tab {
  switch (tab) {
    case "chat":
    case "stream":
    case "apps":
    case "browser":
    case "inventory":
    case "documents":
    case "triggers":
    case "plugins":
    case "skills":
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
    shellLocalStorage.setItem(
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
    shellLocalStorage.setItem(
      AVATAR_INDEX_KEY,
      String(normalizeAvatarIndex(index)),
    );
  }, undefined);
}

export function clearAvatarIndex(): void {
  tryLocalStorage(() => {
    shellLocalStorage.removeItem(AVATAR_INDEX_KEY);
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
    shellLocalStorage.setItem(
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
    shellLocalStorage.setItem(
      RECENT_APPS_KEY,
      JSON.stringify(apps.slice(0, RECENT_APPS_MAX)),
    );
  }, undefined);
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
    shellLocalStorage.setItem(WALLET_ENABLED_KEY, String(value));
  }, undefined);
}

/* ── Continuous chat mode persistence ───────────────────────────────────── */
const CONTINUOUS_CHAT_MODE_KEY = "eliza:voice:continuous-chat-mode";

export function loadContinuousChatMode(): ContinuousChatModeValue {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(CONTINUOUS_CHAT_MODE_KEY);
    const search = typeof window === "undefined" ? "" : window.location.search;
    return resolveContinuousChatMode(stored, search, isElectrobunRuntime());
  }, "off");
}

export function saveContinuousChatMode(mode: ContinuousChatModeValue): void {
  tryLocalStorage(() => {
    shellLocalStorage.setItem(CONTINUOUS_CHAT_MODE_KEY, mode);
  }, undefined);
}

/* ── OS-intent microphone auto-start consent ───────────────────────────── */
// Explicit, reversible consent for deep links/shortcuts to begin capture. Both
// values default false; Settings → Voice and its semantic SETTINGS-action twin
// are the only writers, while the routing authority reads them synchronously at
// the moment an intent is handled.
const OS_INTENT_VOICE_AUTO_START_KEY = "eliza:voice:os-intent-auto-start-voice";
const OS_INTENT_TRANSCRIPTION_AUTO_START_KEY =
  "eliza:voice:os-intent-auto-start-transcription";

export interface OsIntentAutoStartConsent {
  voice: boolean;
  transcription: boolean;
}

export function loadOsIntentAutoStartConsent(): OsIntentAutoStartConsent {
  return tryLocalStorage(
    () => ({
      voice: localStorage.getItem(OS_INTENT_VOICE_AUTO_START_KEY) === "true",
      transcription:
        localStorage.getItem(OS_INTENT_TRANSCRIPTION_AUTO_START_KEY) === "true",
    }),
    { voice: false, transcription: false },
  );
}

export function saveOsIntentAutoStartConsent(
  consent: OsIntentAutoStartConsent,
): void {
  tryLocalStorage(() => {
    shellLocalStorage.setItem(
      OS_INTENT_VOICE_AUTO_START_KEY,
      String(consent.voice),
    );
    shellLocalStorage.setItem(
      OS_INTENT_TRANSCRIPTION_AUTO_START_KEY,
      String(consent.transcription),
    );
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
    shellLocalStorage.setItem(WAKE_WORD_ENABLED_KEY, String(value));
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
    shellLocalStorage.setItem(VAD_AUTO_STOP_KEY, JSON.stringify(value));
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
    shellLocalStorage.setItem(BROWSER_ENABLED_KEY, String(value));
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
    shellLocalStorage.setItem(COMPUTER_USE_ENABLED_KEY, String(value));
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
    shellLocalStorage.setItem(CHAT_AVATAR_VISIBLE_KEY, String(value));
  }, undefined);
}

export function saveChatVoiceMuted(value: boolean): void {
  tryLocalStorage(() => {
    shellLocalStorage.setItem(CHAT_VOICE_MUTED_KEY, String(value));
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
      shellLocalStorage.setItem(ACTIVE_CONVERSATION_ID_KEY, value);
      return;
    }
    shellLocalStorage.removeItem(ACTIVE_CONVERSATION_ID_KEY);
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
    shellLocalStorage.setItem(
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
  /** Cloud runtime currently serving the stable identity encoded by `id`. */
  cloudRuntimeAgentId?: string;
  /** Hosting mode of the current Cloud runtime target. */
  cloudRuntime?: "shared" | "dedicated";
}

const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";

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
  cloudRuntimeAgentId?: string;
  cloudRuntime?: "shared" | "dedicated";
}): PersistedActiveServer {
  const normalizedApiBase = normalizeApiBase(args.apiBase);
  const apiBase = isElizaCloudControlPlaneApiBase(normalizedApiBase)
    ? undefined
    : normalizedApiBase;
  const accessToken = trimPersistedValue(args.accessToken);
  const explicitLabel = trimPersistedValue(args.label);
  const cloudRuntimeAgentId = trimPersistedValue(args.cloudRuntimeAgentId);

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
        ...(cloudRuntimeAgentId ? { cloudRuntimeAgentId } : {}),
        ...(args.cloudRuntime ? { cloudRuntime: args.cloudRuntime } : {}),
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
  const cloudRuntimeAgentId = trimPersistedValue(record.cloudRuntimeAgentId);
  const cloudRuntime =
    record.cloudRuntime === "shared" || record.cloudRuntime === "dedicated"
      ? record.cloudRuntime
      : undefined;

  return {
    id,
    kind,
    label,
    ...(apiBase ? { apiBase } : {}),
    ...(accessToken ? { accessToken } : {}),
    ...(kind === "cloud" && cloudRuntimeAgentId ? { cloudRuntimeAgentId } : {}),
    ...(kind === "cloud" && cloudRuntime ? { cloudRuntime } : {}),
  };
}

// Normalization alone repairs the in-memory record; detecting that specific
// repair lets the load path remove the unusable control-plane base from durable
// storage without rewriting healthy records on every boot.
function persistedRecordNeedsControlPlaneRepair(
  raw: unknown,
  normalized: PersistedActiveServer | null,
): boolean {
  if (!normalized) return false;
  const record = asRecord(raw);
  if (!record) return false;
  const rawApiBase = normalizeApiBase(record.apiBase);
  return (
    !!rawApiBase &&
    isElizaCloudControlPlaneApiBase(rawApiBase) &&
    normalized.apiBase === undefined
  );
}

export function loadPersistedActiveServer(): PersistedActiveServer | null {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(ACTIVE_SERVER_STORAGE_KEY);
    if (!stored) {
      return null;
    }
    const raw = JSON.parse(stored);
    const normalized = normalizePersistedActiveServer(raw);
    // Persist the normalized record once so all readers see the same repaired
    // server target, including readers that do not run this load path.
    if (persistedRecordNeedsControlPlaneRepair(raw, normalized) && normalized) {
      savePersistedActiveServer(normalized);
    }
    return normalized;
  }, null);
}

export function savePersistedActiveServer(
  server: PersistedActiveServer,
): boolean {
  if (typeof localStorage === "undefined") {
    return false;
  }

  // The active-server record carries the sign-in state (kind/apiBase/token) and
  // the backend the app reconnects to. A swallowed persist failure (quota,
  // private-mode SecurityError) silently loses a freshly-recovered apiBase, so
  // backfillCloudApiBase re-runs every boot with no diagnostic. Mirror
  // savePersistedFirstRunComplete: still no-throw + no-op when unavailable, but
  // surface the failure instead of swallowing it.
  try {
    shellLocalStorage.setItem(
      ACTIVE_SERVER_STORAGE_KEY,
      JSON.stringify(server),
    );
    return true;
  } catch (err) {
    // error-policy:J1 localStorage boundary translates an unavailable durable
    // store into an explicit failure that switching callers can surface.
    logger.warn(
      `[persistence] failed to save active server: ${describePersistenceError(err)}`,
    );
    return false;
  }
}

export function clearPersistedActiveServer(): void {
  tryLocalStorage(() => {
    shellLocalStorage.removeItem(ACTIVE_SERVER_STORAGE_KEY);
  }, undefined);
}

/**
 * Clear an account-scoped shared Cloud selection after the Steward account
 * session ends. Shared runtimes have no independent agent credential, so the
 * selected agent id is valid only within the account that selected it; the next
 * login must resolve that account's organization-scoped agent list again.
 */
export function clearPersistedSharedCloudActiveServer(): boolean {
  const current = loadPersistedActiveServer();
  if (!isManagedCloudSharedAgentBase(current?.apiBase)) {
    return false;
  }
  clearPersistedActiveServer();
  return true;
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
