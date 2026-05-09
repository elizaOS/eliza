import { logger } from "@elizaos/core";
import { asRecord } from "@elizaos/shared";
import type { ConversationMode } from "../api/client";
import { fetchWithCsrf } from "../api/csrf-client";
import { getBootConfig } from "../config/boot-config-store";
import {
  DEFAULT_UI_LANGUAGE,
  normalizeLanguage,
  type UiLanguage,
} from "../i18n";
import type { Tab } from "../navigation";
import {
  applyThemeToDocument,
  clearThemeOverrides,
  resolveBuiltinTheme,
} from "../themes/apply-theme";
import type {
  CompanionHalfFramerateMode,
  CompanionVrmPowerMode,
  OnboardingStep,
} from "./types";
import type { UiShellMode, UiTheme } from "./ui-preferences";
import { normalizeAvatarIndex } from "./vrm";

/* ── Shared localStorage helper ──────────────────────────────────────── */

function tryLocalStorage<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (err) {
    console.warn("[persistence] localStorage operation failed:", err);
    return fallback;
  }
}

function describePersistenceError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* ── Theme persistence ────────────────────────────────────────────────── */

export type { UiTheme } from "./ui-preferences";

const UI_THEME_STORAGE_KEY = "eliza:ui-theme";
const LEGACY_UI_THEME_STORAGE_KEY = "elizaos:ui-theme";
const THEME_ID_STORAGE_KEY = "eliza:theme-id";
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

/* ── Theme ID persistence ────────────────────────────────────────────── */

export function loadThemeId(): string {
  return tryLocalStorage(() => {
    return localStorage.getItem(THEME_ID_STORAGE_KEY) ?? "bsc-gold";
  }, "bsc-gold");
}

export function saveThemeId(themeId: string): void {
  tryLocalStorage(() => {
    localStorage.setItem(THEME_ID_STORAGE_KEY, themeId);
  }, undefined);
}

const COMPANION_VRM_POWER_STORAGE_KEY = "eliza:companion-vrm-power";
/** Legacy; migrated into `eliza:companion-vrm-power` on first read. */
const LEGACY_COMPANION_EFFICIENCY_KEY = "eliza:companion-efficiency";
/** Legacy; migrated into `eliza:companion-vrm-power` on first read. */
const LEGACY_COMPANION_QUALITY_ON_BATTERY_KEY =
  "eliza:companion-quality-on-battery";

export function normalizeCompanionVrmPowerMode(
  value: unknown,
): CompanionVrmPowerMode {
  return value === "quality" || value === "efficiency" ? value : "balanced";
}

/**
 * Persisted 3D companion power preference. Migrates legacy boolean keys once.
 */
export function loadCompanionVrmPowerMode(): CompanionVrmPowerMode {
  try {
    const raw = localStorage.getItem(COMPANION_VRM_POWER_STORAGE_KEY);
    if (raw === "quality" || raw === "balanced" || raw === "efficiency") {
      return raw;
    }
    const legacyEffPresent =
      localStorage.getItem(LEGACY_COMPANION_EFFICIENCY_KEY) != null;
    const legacyQobPresent =
      localStorage.getItem(LEGACY_COMPANION_QUALITY_ON_BATTERY_KEY) != null;
    if (legacyEffPresent || legacyQobPresent) {
      const effOn =
        localStorage.getItem(LEGACY_COMPANION_EFFICIENCY_KEY) === "1";
      const qobOn =
        localStorage.getItem(LEGACY_COMPANION_QUALITY_ON_BATTERY_KEY) === "1";
      const migrated: CompanionVrmPowerMode = effOn
        ? "efficiency"
        : qobOn
          ? "quality"
          : "balanced";
      saveCompanionVrmPowerMode(migrated);
      localStorage.removeItem(LEGACY_COMPANION_EFFICIENCY_KEY);
      localStorage.removeItem(LEGACY_COMPANION_QUALITY_ON_BATTERY_KEY);
      return migrated;
    }
    if (raw != null && raw !== "") {
      saveCompanionVrmPowerMode("balanced");
    }
    return "balanced";
  } catch (err) {
    logger.warn(
      `[persistence] failed to load companion VRM power mode: ${describePersistenceError(err)}`,
    );
    return "balanced";
  }
}

export function saveCompanionVrmPowerMode(mode: CompanionVrmPowerMode): void {
  try {
    const next = normalizeCompanionVrmPowerMode(mode);
    localStorage.setItem(COMPANION_VRM_POWER_STORAGE_KEY, next);
    localStorage.removeItem(LEGACY_COMPANION_EFFICIENCY_KEY);
    localStorage.removeItem(LEGACY_COMPANION_QUALITY_ON_BATTERY_KEY);
  } catch (err) {
    logger.warn(
      `[persistence] failed to save companion VRM power mode: ${describePersistenceError(err)}`,
    );
  }
}

const COMPANION_ANIMATE_WHEN_HIDDEN_KEY = "eliza:companion-animate-when-hidden";

/** When true, keep the VRM loop running when the document is hidden; 3D environment is hidden. */
export function loadCompanionAnimateWhenHidden(): boolean {
  try {
    return localStorage.getItem(COMPANION_ANIMATE_WHEN_HIDDEN_KEY) === "1";
  } catch (err) {
    logger.warn(
      `[persistence] failed to load companion animate-when-hidden flag: ${describePersistenceError(err)}`,
    );
    return false;
  }
}

export function saveCompanionAnimateWhenHidden(enabled: boolean): void {
  try {
    localStorage.setItem(
      COMPANION_ANIMATE_WHEN_HIDDEN_KEY,
      enabled ? "1" : "0",
    );
  } catch (err) {
    logger.warn(
      `[persistence] failed to save companion animate-when-hidden flag: ${describePersistenceError(err)}`,
    );
  }
}

const COMPANION_HALF_FRAMERATE_STORAGE_KEY = "eliza:companion-half-framerate";

const COMPANION_HALF_FRAMERATE_VALUES = new Set<string>([
  "off",
  "when_saving_power",
  "always",
]);

function isCompanionHalfFramerateMode(
  value: unknown,
): value is CompanionHalfFramerateMode {
  return (
    typeof value === "string" && COMPANION_HALF_FRAMERATE_VALUES.has(value)
  );
}

export function normalizeCompanionHalfFramerateMode(
  raw: string | null | undefined,
): CompanionHalfFramerateMode {
  if (isCompanionHalfFramerateMode(raw)) return raw;
  return "when_saving_power";
}

export function loadCompanionHalfFramerateMode(): CompanionHalfFramerateMode {
  try {
    return normalizeCompanionHalfFramerateMode(
      localStorage.getItem(COMPANION_HALF_FRAMERATE_STORAGE_KEY),
    );
  } catch (err) {
    logger.warn(
      `[persistence] failed to load companion half-framerate mode: ${describePersistenceError(err)}`,
    );
    return "when_saving_power";
  }
}

export function saveCompanionHalfFramerateMode(
  mode: CompanionHalfFramerateMode,
): void {
  try {
    localStorage.setItem(
      COMPANION_HALF_FRAMERATE_STORAGE_KEY,
      normalizeCompanionHalfFramerateMode(mode),
    );
  } catch (err) {
    logger.warn(
      `[persistence] failed to save companion half-framerate mode: ${describePersistenceError(err)}`,
    );
  }
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

  // Apply the active theme's color set (must run even when only themeId changed)
  const themeId = loadThemeId();
  if (themeId && themeId !== "bsc-gold") {
    const theme = resolveBuiltinTheme(themeId);
    if (theme) {
      applyThemeToDocument(theme, normalizedTheme);
    }
  } else {
    // BSC Gold is the base.css default — clear any overrides
    clearThemeOverrides();
  }
}

const UI_LANGUAGE_STORAGE_KEY = "eliza:ui-language";
const UI_SHELL_MODE_STORAGE_KEY = "eliza:ui-shell-mode";
const LAST_NATIVE_TAB_STORAGE_KEY = "eliza:last-native-tab";
const ONBOARDING_STEP_STORAGE_KEY = "eliza:onboarding:step";

function normalizeOnboardingStep(value: unknown): OnboardingStep | null {
  switch (value) {
    case "deployment":
    case "providers":
    case "features":
      return value;
    case "identity":
      // Identity/character selection was removed; restart at the setup step.
      return "deployment";
    case "permissions":
    case "launch":
      // permissions/launch removed — resume at providers
      return "providers";
    // Legacy step ID migration — map old persisted values to new equivalents
    case "cloud_login":
    case "welcome":
      // cloud_login is now part of deployment step; resume at deployment
      return "deployment";
    case "hosting":
    case "connection":
      // hosting is now part of deployment step; resume at providers
      return "providers";
    case "cloudLogin":
    case "rpc":
      return "providers";
    case "voice":
    case "senses":
      // voice/permissions removed from onboarding; resume at providers
      return "providers";
    case "activate":
      return "providers";
    default:
      return null;
  }
}

export function loadPersistedOnboardingStep(): OnboardingStep | null {
  return tryLocalStorage(
    () =>
      normalizeOnboardingStep(
        localStorage.getItem(ONBOARDING_STEP_STORAGE_KEY),
      ),
    null,
  );
}

export function saveOnboardingStep(step: OnboardingStep): void {
  tryLocalStorage(() => {
    localStorage.setItem(ONBOARDING_STEP_STORAGE_KEY, step);
  }, undefined);
}

export function clearPersistedOnboardingStep(): void {
  tryLocalStorage(() => {
    localStorage.removeItem(ONBOARDING_STEP_STORAGE_KEY);
  }, undefined);
}

/* ── Onboarding completion persistence ────────────────────────────────── */

const ONBOARDING_COMPLETE_STORAGE_KEY = "eliza:onboarding-complete";

export function loadPersistedOnboardingComplete(): boolean {
  if (typeof localStorage === "undefined") {
    return false;
  }

  try {
    return localStorage.getItem(ONBOARDING_COMPLETE_STORAGE_KEY) === "1";
  } catch (err) {
    logger.warn(
      `[persistence] failed to load onboarding completion flag: ${describePersistenceError(err)}`,
    );
    return false;
  }
}

export function savePersistedOnboardingComplete(complete: boolean): void {
  if (typeof localStorage === "undefined") {
    return;
  }

  try {
    if (complete) {
      localStorage.setItem(ONBOARDING_COMPLETE_STORAGE_KEY, "1");
    } else {
      localStorage.removeItem(ONBOARDING_COMPLETE_STORAGE_KEY);
    }
  } catch (err) {
    logger.warn(
      `[persistence] failed to save onboarding completion flag: ${describePersistenceError(err)}`,
    );
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
    return normalizeLanguage(stored ?? DEFAULT_UI_LANGUAGE);
  }, DEFAULT_UI_LANGUAGE);
}

export function saveUiLanguage(language: UiLanguage): void {
  tryLocalStorage(() => {
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, normalizeLanguage(language));
  }, undefined);
}

function normalizeUiShellMode(mode: unknown): UiShellMode {
  return mode === "native" ? "native" : "companion";
}

export { normalizeUiShellMode };

export function loadUiShellMode(): UiShellMode {
  return tryLocalStorage(
    () => normalizeUiShellMode(localStorage.getItem(UI_SHELL_MODE_STORAGE_KEY)),
    "companion",
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
    case "connectors":
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
    logger.warn(
      `[persistence] failed to fetch server favorite apps: ${describePersistenceError(err)}`,
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

/* ── Chat mode persistence ─────────────────────────────────────────────── */
const CHAT_MODE_KEY = "eliza:chat:mode";
const ACTIVE_CONVERSATION_ID_KEY = "eliza:chat:activeConversationId";
const COMPANION_MESSAGE_CUTOFF_TS_KEY = "eliza:chat:companionMessageCutoffTs";

export function loadChatMode(): ConversationMode {
  return tryLocalStorage(() => {
    const stored = localStorage.getItem(CHAT_MODE_KEY);
    return stored === "power" ? "power" : "simple";
  }, "simple");
}

export function saveChatMode(value: ConversationMode): void {
  tryLocalStorage(() => {
    localStorage.setItem(CHAT_MODE_KEY, value);
  }, undefined);
}

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
  return trimmed.slice(0, end);
}

function isElizaCloudControlPlaneApiBase(value: unknown): boolean {
  const apiBase = normalizeApiBase(value);
  if (!apiBase) return false;
  try {
    return ELIZA_CLOUD_CONTROL_PLANE_HOSTS.has(
      new URL(apiBase).hostname.toLowerCase(),
    );
  } catch (err) {
    logger.debug(
      `[persistence] failed to parse apiBase URL while checking Eliza Cloud control plane: apiBase=${apiBase}; error=${describePersistenceError(err)}`,
    );
    return false;
  }
}

export function createPersistedActiveServer(args: {
  kind: PersistedActiveServer["kind"];
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
        id: `cloud:${apiBase ?? "managed"}`,
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
  tryLocalStorage(() => {
    localStorage.setItem(ACTIVE_SERVER_STORAGE_KEY, JSON.stringify(server));
  }, undefined);
}

export function clearPersistedActiveServer(): void {
  tryLocalStorage(() => {
    localStorage.removeItem(ACTIVE_SERVER_STORAGE_KEY);
  }, undefined);
}
