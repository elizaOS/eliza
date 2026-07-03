import { useSyncExternalStore } from "react";

/**
 * User-configurable global hotkey that toggles the floating chat surface
 * (#10716 / #12184). On desktop the main window *is* the chat-overlay bottom
 * bar, so the hotkey toggles it: when the window is already focused + visible
 * the press dismisses it (focus returns to the previously active app);
 * otherwise it shows + focuses it. The chosen accelerator is registered with
 * the OS via `Desktop.registerShortcut({ id: "chat-overlay" })`; pressing it
 * fires `desktopShortcutPressed`, which the shell handles with the pure
 * `decideChatOverlayToggle()` decision (packages/app/src/desktop-hotkey.ts).
 *
 * This is intentionally separate from the `command-palette` binding
 * (`CommandOrControl+K`): summoning chat and opening the palette are distinct
 * actions, so both shortcuts are registered and the default chat accelerator is
 * chosen to not collide with the palette (nor with Option+Space, which Claude
 * and ChatGPT desktop both squat). Persisted to localStorage so it survives
 * reloads and is readable synchronously at desktop boot.
 */

const STORAGE_KEY = "eliza:chatOverlayHotkey";

/**
 * Default summon accelerator. Distinct from `CommandOrControl+K`
 * (command-palette) so registering both never conflicts.
 */
export const DEFAULT_CHAT_OVERLAY_ACCELERATOR = "CommandOrControl+Shift+C";

export interface ChatOverlayHotkey {
  /** OS accelerator string (Electrobun GlobalShortcut syntax). */
  readonly accelerator: string;
  /** When false, the shortcut is not registered. */
  readonly enabled: boolean;
}

const DEFAULT_HOTKEY: ChatOverlayHotkey = {
  accelerator: DEFAULT_CHAT_OVERLAY_ACCELERATOR,
  enabled: true,
};

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

/**
 * Resolve a persisted hotkey blob (or anything) into a valid
 * {@link ChatOverlayHotkey}, falling back to the default accelerator/enabled
 * state for missing or malformed fields. Pure — the single place that turns
 * untrusted storage into the typed shape used everywhere else.
 */
export function resolveChatOverlayHotkey(value: unknown): ChatOverlayHotkey {
  if (!value || typeof value !== "object") {
    return DEFAULT_HOTKEY;
  }
  const record = value as { accelerator?: unknown; enabled?: unknown };
  const accelerator =
    typeof record.accelerator === "string"
      ? normalizeAccelerator(record.accelerator)
      : null;
  const enabled =
    typeof record.enabled === "boolean"
      ? record.enabled
      : DEFAULT_HOTKEY.enabled;
  return {
    accelerator: accelerator ?? DEFAULT_CHAT_OVERLAY_ACCELERATOR,
    enabled,
  };
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

const listeners = new Set<() => void>();

function readStorage(): ChatOverlayHotkey {
  if (typeof window === "undefined") {
    return DEFAULT_HOTKEY;
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return DEFAULT_HOTKEY;
    }
    return resolveChatOverlayHotkey(JSON.parse(raw));
  } catch {
    return DEFAULT_HOTKEY;
  }
}

/**
 * Cached snapshot — `getSnapshot` runs on every render of every subscriber, so
 * it must return a stable reference without per-render localStorage I/O.
 * Refreshed only on `setChatOverlayHotkey` or a cross-tab `storage` event.
 */
let cached: ChatOverlayHotkey = readStorage();

function sameHotkey(a: ChatOverlayHotkey, b: ChatOverlayHotkey): boolean {
  return a.accelerator === b.accelerator && a.enabled === b.enabled;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== null && event.key !== STORAGE_KEY) {
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getChatOverlayHotkey(): ChatOverlayHotkey {
  return cached;
}

export function setChatOverlayHotkey(next: Partial<ChatOverlayHotkey>): void {
  const resolved = resolveChatOverlayHotkey({ ...cached, ...next });
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(resolved));
    } catch {
      // localStorage unavailable (private mode, quota, etc.) — fall through.
    }
  }
  if (sameHotkey(resolved, cached)) {
    return;
  }
  cached = resolved;
  for (const listener of listeners) {
    listener();
  }
}

export function useChatOverlayHotkey(): ChatOverlayHotkey {
  return useSyncExternalStore(
    subscribe,
    getChatOverlayHotkey,
    () => DEFAULT_HOTKEY,
  );
}
