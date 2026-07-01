/**
 * Programmable global hotkey that summons the floating chat overlay to the
 * foreground (Claude-Desktop / Wispr-Flow style), plus the persisted desktop
 * hotkey settings it reads from.
 *
 * This module is intentionally pure (no Electrobun / filesystem imports) so the
 * accelerator validation, defaulting, and settings (de)serialization are unit
 * testable. It ships in the renderer bundle: the desktop shell registers the
 * chat hotkey from the renderer (same path as the command palette) and persists
 * the chosen accelerator in `localStorage`. The renderer summon handler lives in
 * `packages/app/src/main.tsx`; the "Summon Chat" menu/tray click paths live in
 * the Electrobun main process.
 *
 * Issue #10716.
 */

/** Global-shortcut id for the chat-summon accelerator (distinct from the
 * `command-palette` binding on `CommandOrControl+K`). */
export const SUMMON_CHAT_SHORTCUT_ID = "summon-chat";

/** localStorage key the desktop shell persists the hotkey settings JSON under. */
export const DESKTOP_HOTKEY_STORAGE_KEY = "eliza:desktop:hotkey-settings";

/**
 * Browser-safe OS detection. This module ships in the renderer bundle, where
 * `process` is absent — fall back to the user agent.
 */
export function currentPlatform(): NodeJS.Platform {
  if (typeof process !== "undefined" && process.platform) {
    return process.platform;
  }
  if (typeof navigator !== "undefined") {
    const ua = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
    if (/Mac|iPhone|iPad|iPod/i.test(ua)) return "darwin";
    if (/Win/i.test(ua)) return "win32";
  }
  return "linux";
}

/**
 * Default accelerator that summons/fronts the floating chat overlay.
 *
 * macOS: ⌘⇧Space — deliberately distinct from Spotlight (⌘Space) and the
 * command palette (⌘K). Elsewhere: Ctrl+Shift+Space.
 */
export function defaultChatSummonAccelerator(
  platform: NodeJS.Platform = currentPlatform(),
): string {
  return platform === "darwin"
    ? "Command+Shift+Space"
    : "Control+Shift+Space";
}

/**
 * Modifier tokens Electrobun's `GlobalShortcut` accepts (Electron-compatible
 * accelerator grammar). Canonical spelling is the map value; aliases resolve to
 * it so `cmd`, `CmdOrCtrl`, `option` all normalize.
 */
const MODIFIER_ALIASES: ReadonlyMap<string, string> = new Map([
  ["command", "Command"],
  ["cmd", "Command"],
  ["control", "Control"],
  ["ctrl", "Control"],
  ["commandorcontrol", "CommandOrControl"],
  ["cmdorctrl", "CommandOrControl"],
  ["alt", "Alt"],
  ["option", "Alt"],
  ["altgr", "AltGr"],
  ["shift", "Shift"],
  ["super", "Super"],
  ["meta", "Super"],
]);

/**
 * Canonical spellings for the accepted non-modifier "key" token. A valid
 * accelerator has exactly one key token plus zero or more modifiers.
 */
const KEY_ALIASES: ReadonlyMap<string, string> = new Map([
  ["space", "Space"],
  ["tab", "Tab"],
  ["backspace", "Backspace"],
  ["delete", "Delete"],
  ["del", "Delete"],
  ["insert", "Insert"],
  ["return", "Return"],
  ["enter", "Enter"],
  ["up", "Up"],
  ["down", "Down"],
  ["left", "Left"],
  ["right", "Right"],
  ["home", "Home"],
  ["end", "End"],
  ["pageup", "PageUp"],
  ["pagedown", "PageDown"],
  ["escape", "Escape"],
  ["esc", "Escape"],
  ["plus", "Plus"],
]);

function canonicalKeyToken(raw: string): string | null {
  const lower = raw.toLowerCase();
  const alias = KEY_ALIASES.get(lower);
  if (alias) return alias;
  // Single alphanumeric character (letters upper-cased for stable comparison).
  if (/^[a-z0-9]$/.test(lower)) return lower.toUpperCase();
  // Function keys F1–F24.
  const fn = /^f([1-9]|1[0-9]|2[0-4])$/.exec(lower);
  if (fn) return `F${fn[1]}`;
  return null;
}

/**
 * Normalize an accelerator string to canonical Electrobun form, or `null` when
 * it is not a valid accelerator (empty, no key, two keys, or an unknown token).
 * Modifier order is canonicalized so equivalent strings compare equal.
 */
export function normalizeAccelerator(input: string | null | undefined): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  const parts = trimmed.split("+").map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) return null;

  const modifiers: string[] = [];
  let key: string | null = null;

  for (const part of parts) {
    const modifier = MODIFIER_ALIASES.get(part.toLowerCase());
    if (modifier) {
      if (modifiers.includes(modifier)) return null; // duplicate modifier
      modifiers.push(modifier);
      continue;
    }
    const keyToken = canonicalKeyToken(part);
    if (!keyToken) return null; // unknown token
    if (key) return null; // more than one key
    key = keyToken;
  }

  if (!key) return null; // accelerator must include a key

  // Stable modifier ordering (Electron convention: Ctrl/Cmd, Alt, Shift, Super).
  const ORDER = [
    "CommandOrControl",
    "Command",
    "Control",
    "Alt",
    "AltGr",
    "Shift",
    "Super",
  ];
  modifiers.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));

  return [...modifiers, key].join("+");
}

/** Whether `input` is a valid accelerator. */
export function isValidAccelerator(input: string | null | undefined): boolean {
  return normalizeAccelerator(input) !== null;
}

/**
 * Whether the accelerator is a safe *global* hotkey. A bare key or a single
 * Shift+key is rejected — global shortcuts steal the binding from every app, so
 * we require at least one non-Shift modifier (Cmd/Ctrl/Alt/Super) to avoid
 * hijacking ordinary typing. Used to gate user-entered accelerators.
 */
export function isSafeGlobalAccelerator(input: string | null | undefined): boolean {
  const normalized = normalizeAccelerator(input);
  if (!normalized) return false;
  const tokens = normalized.split("+");
  return tokens.some(
    (t) =>
      t === "CommandOrControl" ||
      t === "Command" ||
      t === "Control" ||
      t === "Alt" ||
      t === "AltGr" ||
      t === "Super",
  );
}

/** Persisted desktop hotkey preferences (state-dir JSON). */
export interface DesktopHotkeySettings {
  /**
   * User-chosen accelerator for summoning chat. `null` means "use the
   * per-platform default" ({@link defaultChatSummonAccelerator}).
   */
  chatSummonAccelerator: string | null;
}

export const DEFAULT_DESKTOP_HOTKEY_SETTINGS: DesktopHotkeySettings = {
  chatSummonAccelerator: null,
};

/**
 * Parse persisted settings from unknown JSON, tolerating a missing/partial/
 * corrupt file by falling back to defaults. An invalid or unsafe accelerator is
 * dropped (reverts to the default) rather than silently registering a bad
 * binding.
 */
export function parseDesktopHotkeySettings(raw: unknown): DesktopHotkeySettings {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_DESKTOP_HOTKEY_SETTINGS };
  }
  const candidate = (raw as { chatSummonAccelerator?: unknown })
    .chatSummonAccelerator;
  if (typeof candidate !== "string") {
    return { ...DEFAULT_DESKTOP_HOTKEY_SETTINGS };
  }
  const normalized = normalizeAccelerator(candidate);
  if (!normalized || !isSafeGlobalAccelerator(normalized)) {
    return { ...DEFAULT_DESKTOP_HOTKEY_SETTINGS };
  }
  return { chatSummonAccelerator: normalized };
}

/** Serialize settings to canonical JSON for persistence. */
export function serializeDesktopHotkeySettings(
  settings: DesktopHotkeySettings,
): string {
  const accelerator = settings.chatSummonAccelerator
    ? normalizeAccelerator(settings.chatSummonAccelerator)
    : null;
  return `${JSON.stringify({ chatSummonAccelerator: accelerator }, null, 2)}\n`;
}

/**
 * Resolve the effective chat-summon accelerator: the user override when it is a
 * valid safe global hotkey, else the per-platform default.
 */
export function resolveChatSummonAccelerator(
  settings: DesktopHotkeySettings,
  platform: NodeJS.Platform = currentPlatform(),
): string {
  const override = settings.chatSummonAccelerator;
  if (override && isSafeGlobalAccelerator(override)) {
    return normalizeAccelerator(override) as string;
  }
  return defaultChatSummonAccelerator(platform);
}

/**
 * Load persisted hotkey settings from `localStorage` (renderer). Never throws —
 * returns defaults when storage is unavailable or the stored value is corrupt.
 */
export function loadDesktopHotkeySettings(): DesktopHotkeySettings {
  if (typeof localStorage === "undefined") {
    return { ...DEFAULT_DESKTOP_HOTKEY_SETTINGS };
  }
  try {
    const raw = localStorage.getItem(DESKTOP_HOTKEY_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_DESKTOP_HOTKEY_SETTINGS };
    return parseDesktopHotkeySettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_DESKTOP_HOTKEY_SETTINGS };
  }
}

/**
 * Persist hotkey settings to `localStorage` (renderer). Returns the normalized
 * settings actually stored so callers can re-register with the canonical value.
 */
export function saveDesktopHotkeySettings(
  settings: DesktopHotkeySettings,
): DesktopHotkeySettings {
  const normalized = parseDesktopHotkeySettings(settings);
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(
        DESKTOP_HOTKEY_STORAGE_KEY,
        serializeDesktopHotkeySettings(normalized),
      );
    } catch {
      // Storage full / disabled — the in-memory registration still applies.
    }
  }
  return normalized;
}
