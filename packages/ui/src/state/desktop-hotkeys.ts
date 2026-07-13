/**
 * Keyed store family for the desktop global hotkeys, plus the pure accelerator
 * helpers every hotkey surface shares. Three OS-level shortcuts exist today —
 * chat summon (`useChatOverlayHotkey`, which builds on the factory here and
 * keeps its historical localStorage key so persisted settings survive), the
 * voice-conversation toggle, and the transcription toggle. Each store persists
 * `{ accelerator, enabled }` to its own localStorage key, is readable
 * synchronously at desktop boot (packages/app main.tsx registers the enabled
 * shortcuts before the first press can arrive), and notifies React subscribers
 * via useSyncExternalStore. The Settings recorder re-registers a changed
 * accelerator live over the desktop bridge; this module only owns persistence
 * and the parsed shape.
 */
import { logger } from "@elizaos/logger";
import { useSyncExternalStore } from "react";
import { shellLocalStorage } from "../surface-realm-channel";

export interface DesktopHotkey {
  /** OS accelerator string (Electrobun GlobalShortcut syntax). */
  readonly accelerator: string;
  /** When false, the shortcut is not registered. */
  readonly enabled: boolean;
}

/**
 * Collapse whitespace and drop empty tokens from a raw accelerator string.
 * Returns `null` when the input has no usable key tokens, so callers can fall
 * back to the default rather than register an empty accelerator.
 */
export function normalizeAccelerator(raw: string): string | null {
  const tokens = raw
    .split("+")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return null;
  }
  return tokens.join("+");
}

/** Keys that only act as modifiers — never a standalone accelerator. */
const MODIFIER_KEYS = new Set([
  "Control",
  "Meta",
  "Alt",
  "Shift",
  "OS",
  "AltGraph",
]);

/**
 * Convert a captured keyboard event into an Electrobun accelerator string
 * (e.g. `CommandOrControl+Shift+C`), or `null` when the event carries only
 * modifier keys (nothing to bind yet). `CommandOrControl` is emitted for
 * Ctrl/Cmd so the same accelerator maps to ⌘ on macOS and Ctrl elsewhere.
 * Pure — drives the settings recorder and is unit-tested directly.
 */
export function acceleratorFromKeyboardEvent(event: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  if (MODIFIER_KEYS.has(event.key)) {
    return null;
  }
  const hasModifier =
    event.ctrlKey || event.metaKey || event.altKey || event.shiftKey;
  // A bare single printable character (e.g. "C") is rejected as a global
  // accelerator — registering it would hijack that key everywhere the app is
  // backgrounded. Require at least one modifier for printable keys; named keys
  // (F-keys, Space, arrows, …) may bind on their own.
  if (event.key.length === 1 && !hasModifier) {
    return null;
  }
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) {
    parts.push("CommandOrControl");
  }
  if (event.altKey) {
    parts.push("Alt");
  }
  if (event.shiftKey) {
    parts.push("Shift");
  }
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  parts.push(key);
  return parts.join("+");
}

export interface DesktopHotkeyStore {
  /** Resting state used when nothing (valid) is persisted. */
  readonly defaultHotkey: DesktopHotkey;
  /** localStorage key the store persists to (stable API contract). */
  readonly storageKey: string;
  /**
   * Resolve a persisted hotkey blob (or anything) into a valid
   * {@link DesktopHotkey}, falling back to this store's defaults for missing or
   * malformed fields. Pure — the single place that turns untrusted storage into
   * the typed shape used everywhere else.
   */
  resolve(value: unknown): DesktopHotkey;
  get(): DesktopHotkey;
  set(next: Partial<DesktopHotkey>): void;
  subscribe(listener: () => void): () => void;
  /** Server-snapshot for useSyncExternalStore (SSR/jsdom-safe). */
  getDefault(): DesktopHotkey;
}

/**
 * Build a persisted hotkey store. The snapshot is cached — `get` runs on every
 * render of every subscriber, so it must return a stable reference without
 * per-render localStorage I/O; the cache refreshes only on `set` or a
 * cross-tab `storage` event.
 */
export function createDesktopHotkeyStore(options: {
  storageKey: string;
  defaultAccelerator: string;
  defaultEnabled: boolean;
}): DesktopHotkeyStore {
  const { storageKey } = options;
  const defaultHotkey: DesktopHotkey = {
    accelerator: options.defaultAccelerator,
    enabled: options.defaultEnabled,
  };

  function resolve(value: unknown): DesktopHotkey {
    if (!value || typeof value !== "object") {
      return defaultHotkey;
    }
    const record = value as { accelerator?: unknown; enabled?: unknown };
    const accelerator =
      typeof record.accelerator === "string"
        ? normalizeAccelerator(record.accelerator)
        : null;
    const enabled =
      typeof record.enabled === "boolean"
        ? record.enabled
        : defaultHotkey.enabled;
    return {
      accelerator: accelerator ?? defaultHotkey.accelerator,
      enabled,
    };
  }

  function readStorage(): DesktopHotkey {
    if (typeof window === "undefined") {
      return defaultHotkey;
    }
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) {
        return defaultHotkey;
      }
      return resolve(JSON.parse(raw));
    } catch {
      // error-policy:J3 untrusted persisted blob — malformed JSON (or a
      // storage-blocked context) resolves to the typed default, never throws
      // into the render path.
      return defaultHotkey;
    }
  }

  const listeners = new Set<() => void>();
  let cached: DesktopHotkey = readStorage();

  function sameHotkey(a: DesktopHotkey, b: DesktopHotkey): boolean {
    return a.accelerator === b.accelerator && a.enabled === b.enabled;
  }

  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key !== null && event.key !== storageKey) {
        return;
      }
      const next = readStorage();
      if (sameHotkey(next, cached)) {
        return;
      }
      cached = next;
      for (const listener of listeners) {
        listener();
      }
    });
  }

  return {
    defaultHotkey,
    storageKey,
    resolve,
    get: () => cached,
    getDefault: () => defaultHotkey,
    set: (next: Partial<DesktopHotkey>) => {
      const resolved = resolve({ ...cached, ...next });
      if (typeof window !== "undefined") {
        try {
          shellLocalStorage.setItem(storageKey, JSON.stringify(resolved));
        } catch (error) {
          // error-policy:J6 localStorage unavailable (private mode, quota) —
          // the in-memory state still updates below; only persistence degrades.
          logger.debug(
            `[desktopHotkeys] persist skipped for ${storageKey}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      if (sameHotkey(resolved, cached)) {
        return;
      }
      cached = resolved;
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ── Voice-conversation toggle hotkey ─────────────────────────────────────────
// Pressing it summons the main window and dispatches
// `dispatchVoiceControl({ command: "converse-toggle" })` — press again to end
// the conversation. Enabled by default: voice is a headline desktop affordance
// and the accelerator is chosen to collide with neither the chat summon
// (CommandOrControl+Shift+C) nor the palette (CommandOrControl+K).

export const DEFAULT_VOICE_HOTKEY_ACCELERATOR = "CommandOrControl+Shift+M";
export const VOICE_HOTKEY_STORAGE_KEY = "eliza:voiceHotkey";
/** Shortcut id registered with the OS for the voice-conversation toggle. */
export const VOICE_SHORTCUT_ID = "voice";

export const voiceHotkeyStore = createDesktopHotkeyStore({
  storageKey: VOICE_HOTKEY_STORAGE_KEY,
  defaultAccelerator: DEFAULT_VOICE_HOTKEY_ACCELERATOR,
  defaultEnabled: true,
});

export function getVoiceHotkey(): DesktopHotkey {
  return voiceHotkeyStore.get();
}

export function setVoiceHotkey(next: Partial<DesktopHotkey>): void {
  voiceHotkeyStore.set(next);
}

export function useVoiceHotkey(): DesktopHotkey {
  return useSyncExternalStore(
    voiceHotkeyStore.subscribe,
    voiceHotkeyStore.get,
    voiceHotkeyStore.getDefault,
  );
}

// ── Transcription toggle hotkey ──────────────────────────────────────────────
// Dispatches `{ command: "transcribe-toggle" }` (long-form record-only capture).
// DISABLED by default — transcription is a deliberate opt-in surface, and an
// idle default keeps the registered global-shortcut footprint minimal.

export const DEFAULT_TRANSCRIBE_HOTKEY_ACCELERATOR = "CommandOrControl+Alt+T";
export const TRANSCRIBE_HOTKEY_STORAGE_KEY = "eliza:transcribeHotkey";
/** Shortcut id registered with the OS for the transcription toggle. */
export const TRANSCRIBE_SHORTCUT_ID = "transcribe";

export const transcribeHotkeyStore = createDesktopHotkeyStore({
  storageKey: TRANSCRIBE_HOTKEY_STORAGE_KEY,
  defaultAccelerator: DEFAULT_TRANSCRIBE_HOTKEY_ACCELERATOR,
  defaultEnabled: false,
});

export function getTranscribeHotkey(): DesktopHotkey {
  return transcribeHotkeyStore.get();
}

export function setTranscribeHotkey(next: Partial<DesktopHotkey>): void {
  transcribeHotkeyStore.set(next);
}

export function useTranscribeHotkey(): DesktopHotkey {
  return useSyncExternalStore(
    transcribeHotkeyStore.subscribe,
    transcribeHotkeyStore.get,
    transcribeHotkeyStore.getDefault,
  );
}
