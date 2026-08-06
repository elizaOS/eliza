// Detects Mac at module load time (safe to call on client, returns false on server)
export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);

export interface ParsedKey {
  mod: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/**
 * Parse a shortcut string like "mod+shift+k" into a structured object.
 * Supports modifiers: mod, ctrl, shift, alt
 * `mod` = Cmd on Mac, Ctrl on Win/Linux
 */
export function parseKey(keyString: string): ParsedKey {
  const parts = keyString.toLowerCase().split("+");
  const key = parts[parts.length - 1];
  return {
    mod: parts.includes("mod"),
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    key,
  };
}

/**
 * Test whether a KeyboardEvent matches a parsed key definition.
 */
export function matchesEvent(parsed: ParsedKey, e: KeyboardEvent): boolean {
  // On Mac, `mod` maps to metaKey; on Win/Linux it maps to ctrlKey
  const expectedMeta = isMac ? parsed.mod : false;
  const expectedCtrl = isMac ? parsed.ctrl : parsed.mod || parsed.ctrl;

  if (e.metaKey !== expectedMeta) return false;
  if (e.ctrlKey !== expectedCtrl) return false;
  if (e.altKey !== parsed.alt) return false;

  // For alphanumeric keys, enforce the shift modifier check explicitly.
  // For symbol characters (?, /, comma, etc.) shift is implicit in the key value,
  // so we skip the shift check and just match on e.key.
  const keyIsAlphanumeric = /^[a-z0-9]$/.test(parsed.key);
  if (keyIsAlphanumeric && e.shiftKey !== parsed.shift) return false;

  return e.key.toLowerCase() === parsed.key;
}

/**
 * Format a key combo string for display.
 * Returns an array of display segments, e.g. ["⌘", "K"] or ["Ctrl", "K"].
 */
export function formatKeyCombo(keyString: string): string[] {
  const parts = keyString.split("+");
  return parts.map((part) => {
    switch (part.toLowerCase()) {
      case "mod":
        return isMac ? "⌘" : "Ctrl";
      case "shift":
        return isMac ? "⇧" : "Shift";
      case "alt":
        return isMac ? "⌥" : "Alt";
      case "ctrl":
        return isMac ? "⌃" : "Ctrl";
      case "enter":
        return "↵";
      case "escape":
        return "Esc";
      case "backspace":
        return "⌫";
      case "tab":
        return "Tab";
      case "arrowup":
        return "↑";
      case "arrowdown":
        return "↓";
      case "arrowleft":
        return "←";
      case "arrowright":
        return "→";
      default:
        return part.toUpperCase();
    }
  });
}
