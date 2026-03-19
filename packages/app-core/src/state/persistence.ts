import type { ConversationMode } from "../api/client";
import {
  DEFAULT_UI_LANGUAGE,
  normalizeLanguage,
  type UiLanguage,
} from "../i18n";
import type { Tab } from "../navigation";
import type { OnboardingStep } from "./types";
import type { UiShellMode, UiTheme } from "./ui-preferences";
import { normalizeAvatarIndex } from "./vrm";

/* ── Theme persistence ────────────────────────────────────────────────── */

export type { UiTheme } from "./ui-preferences";

const UI_THEME_STORAGE_KEY = "eliza:ui-theme";

function normalizeUiTheme(value: unknown): UiTheme {
  return value === "light" ? "light" : "dark";
}

export { normalizeUiTheme };

export function loadUiTheme(): UiTheme {
  try {
    return normalizeUiTheme(localStorage.getItem(UI_THEME_STORAGE_KEY));
  } catch {
    return "dark";
  }
}

export function saveUiTheme(theme: UiTheme): void {
  try {
    localStorage.setItem(UI_THEME_STORAGE_KEY, normalizeUiTheme(theme));
  } catch {
    // ignore
  }
}

/**
 * Apply the theme to the document root.
 * Sets both `data-theme` attribute and `.dark` class so both CSS selectors
 * in base.css (`[data-theme="dark"]` and `.dark`) are satisfied.
 */
export function applyUiTheme(theme: UiTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (!root) return;
  if (typeof root.setAttribute === "function") {
    root.setAttribute("data-theme", theme);
  } else if ("dataset" in root && root.dataset) {
    root.dataset.theme = theme;
  } else {
    return;
  }
  if (!root.classList) return;
  if (theme === "dark") {
    root.classList.add("dark");
  } else {
    root.classList.remove("dark");
  }
}

const UI_LANGUAGE_STORAGE_KEY = "eliza:ui-language";
const UI_SHELL_MODE_STORAGE_KEY = "eliza:ui-shell-mode";
const LAST_NATIVE_TAB_STORAGE_KEY = "eliza:last-native-tab";
const ONBOARDING_STEP_STORAGE_KEY = "eliza:onboarding:step";

function normalizeOnboardingStep(value: unknown): OnboardingStep | null {
  switch (value) {
    case "identity":
    case "connection":
    case "rpc":
    case "senses":
    case "activate":
      return value;
    default:
      return null;
  }
}

export function loadPersistedOnboardingStep(): OnboardingStep | null {
  try {
    return normalizeOnboardingStep(
      localStorage.getItem(ONBOARDING_STEP_STORAGE_KEY),
    );
  } catch {
    return null;
  }
}

export function saveOnboardingStep(step: OnboardingStep): void {
  try {
    localStorage.setItem(ONBOARDING_STEP_STORAGE_KEY, step);
  } catch {
    /* ignore */
  }
}

export function clearPersistedOnboardingStep(): void {
  try {
    localStorage.removeItem(ONBOARDING_STEP_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function loadUiLanguage(): UiLanguage {
  try {
    const stored = localStorage.getItem(UI_LANGUAGE_STORAGE_KEY);
    return normalizeLanguage(stored ?? DEFAULT_UI_LANGUAGE);
  } catch {
    return DEFAULT_UI_LANGUAGE;
  }
}

export function saveUiLanguage(language: UiLanguage): void {
  try {
    localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, normalizeLanguage(language));
  } catch {
    // ignore
  }
}

function normalizeUiShellMode(mode: unknown): UiShellMode {
  return mode === "native" ? "native" : "companion";
}

export { normalizeUiShellMode };

export function loadUiShellMode(): UiShellMode {
  try {
    return normalizeUiShellMode(
      localStorage.getItem(UI_SHELL_MODE_STORAGE_KEY),
    );
  } catch {
    return "companion";
  }
}

export function saveUiShellMode(mode: UiShellMode): void {
  try {
    localStorage.setItem(UI_SHELL_MODE_STORAGE_KEY, normalizeUiShellMode(mode));
  } catch {
    // ignore
  }
}

function normalizeLastNativeTab(tab: unknown): Tab {
  switch (tab) {
    case "chat":
    case "stream":
    case "apps":
    case "wallets":
    case "knowledge":
    case "connectors":
    case "triggers":
    case "plugins":
    case "skills":
    case "actions":
    case "advanced":
    case "fine-tuning":
    case "voice":
    case "runtime":
    case "database":
    case "settings":
    case "logs":
    case "security":
      return tab;
    default:
      return "chat";
  }
}

export function loadLastNativeTab(): Tab {
  try {
    return normalizeLastNativeTab(
      localStorage.getItem(LAST_NATIVE_TAB_STORAGE_KEY),
    );
  } catch {
    return "chat";
  }
}

export function saveLastNativeTab(tab: Tab): void {
  try {
    localStorage.setItem(
      LAST_NATIVE_TAB_STORAGE_KEY,
      normalizeLastNativeTab(tab),
    );
  } catch {
    // ignore
  }
}

/* ── Avatar persistence ───────────────────────────────────────────────── */
const AVATAR_INDEX_KEY = "eliza_avatar_index";

export function loadAvatarIndex(): number {
  try {
    const stored = localStorage.getItem(AVATAR_INDEX_KEY);
    if (stored) {
      const n = parseInt(stored, 10);
      return normalizeAvatarIndex(n);
    }
  } catch {
    /* ignore */
  }
  return 1;
}

export function saveAvatarIndex(index: number): void {
  try {
    localStorage.setItem(AVATAR_INDEX_KEY, String(normalizeAvatarIndex(index)));
  } catch {
    /* ignore */
  }
}

/* ── Chat UI persistence ──────────────────────────────────────────────── */
const CHAT_AVATAR_VISIBLE_KEY = "eliza:chat:avatarVisible";
const CHAT_VOICE_MUTED_KEY = "eliza:chat:voiceMuted";

export function loadChatAvatarVisible(): boolean {
  try {
    const stored = localStorage.getItem(CHAT_AVATAR_VISIBLE_KEY);
    return stored === null ? true : stored === "true";
  } catch {
    return true;
  }
}

export function loadChatVoiceMuted(): boolean {
  try {
    const stored = localStorage.getItem(CHAT_VOICE_MUTED_KEY);
    return stored === null ? false : stored === "true";
  } catch {
    return false;
  }
}

export function saveChatAvatarVisible(value: boolean): void {
  try {
    localStorage.setItem(CHAT_AVATAR_VISIBLE_KEY, String(value));
  } catch {
    /* ignore */
  }
}

export function saveChatVoiceMuted(value: boolean): void {
  try {
    localStorage.setItem(CHAT_VOICE_MUTED_KEY, String(value));
  } catch {
    /* ignore */
  }
}

/* ── Chat mode persistence ─────────────────────────────────────────────── */
const CHAT_MODE_KEY = "eliza:chat:mode";
const ACTIVE_CONVERSATION_ID_KEY = "eliza:chat:activeConversationId";
const COMPANION_MESSAGE_CUTOFF_TS_KEY = "eliza:chat:companionMessageCutoffTs";

export function loadChatMode(): ConversationMode {
  try {
    const stored = localStorage.getItem(CHAT_MODE_KEY);
    return stored === "power" ? "power" : "simple";
  } catch {
    return "simple";
  }
}

export function saveChatMode(value: ConversationMode): void {
  try {
    localStorage.setItem(CHAT_MODE_KEY, value);
  } catch {
    /* ignore */
  }
}

export function loadActiveConversationId(): string | null {
  try {
    const stored = localStorage.getItem(ACTIVE_CONVERSATION_ID_KEY)?.trim();
    return stored ? stored : null;
  } catch {
    return null;
  }
}

export function saveActiveConversationId(value: string | null): void {
  try {
    if (value?.trim()) {
      localStorage.setItem(ACTIVE_CONVERSATION_ID_KEY, value);
      return;
    }
    localStorage.removeItem(ACTIVE_CONVERSATION_ID_KEY);
  } catch {
    /* ignore */
  }
}

export function loadCompanionMessageCutoffTs(): number {
  try {
    const stored = localStorage.getItem(COMPANION_MESSAGE_CUTOFF_TS_KEY);
    const parsed = stored ? Number.parseInt(stored, 10) : Number.NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
  } catch {
    return Date.now();
  }
}

export function saveCompanionMessageCutoffTs(value: number): void {
  try {
    localStorage.setItem(
      COMPANION_MESSAGE_CUTOFF_TS_KEY,
      String(Math.max(0, Math.trunc(value))),
    );
  } catch {
    /* ignore */
  }
}

/* ── Connection mode persistence ──────────────────────────────────────── */

/**
 * Persisted connection state so the app knows how to connect on restart
 * without waiting for a backend that may not exist yet.
 */
export interface PersistedConnectionMode {
  /** "local" = embedded agent, "cloud" = eliza cloud sandbox, "remote" = custom URL */
  runMode: "local" | "cloud" | "remote";
  /** For cloud: the eliza cloud API base URL */
  cloudApiBase?: string;
  /** For cloud: the auth token */
  cloudAuthToken?: string;
  /** For remote: the remote API base URL */
  remoteApiBase?: string;
  /** For remote: the access token/connection key */
  remoteAccessToken?: string;
}

const CONNECTION_MODE_STORAGE_KEY = "eliza:connection-mode";

export function loadPersistedConnectionMode(): PersistedConnectionMode | null {
  try {
    const stored = localStorage.getItem(CONNECTION_MODE_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed.runMode === "local" ||
        parsed.runMode === "cloud" ||
        parsed.runMode === "remote")
    ) {
      return parsed as PersistedConnectionMode;
    }
    return null;
  } catch {
    return null;
  }
}

export function savePersistedConnectionMode(
  mode: PersistedConnectionMode,
): void {
  try {
    localStorage.setItem(CONNECTION_MODE_STORAGE_KEY, JSON.stringify(mode));
  } catch {
    /* ignore */
  }
}

export function clearPersistedConnectionMode(): void {
  try {
    localStorage.removeItem(CONNECTION_MODE_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
