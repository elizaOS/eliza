/**
 * Keyboard shortcuts manager for the application.
 */

import { useCallback, useEffect } from "react";

export interface ShortcutConfig {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  handler: () => void;
  description: string;
  scope?: "global" | "chat" | "settings";
}

export function useKeyboardShortcuts(shortcuts: ShortcutConfig[]) {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      for (const shortcut of shortcuts) {
        const keyMatch = event.key.toLowerCase() === shortcut.key.toLowerCase();
        const ctrlMatch = !!shortcut.ctrl === event.ctrlKey;
        const shiftMatch = !!shortcut.shift === event.shiftKey;
        const altMatch = !!shortcut.alt === event.altKey;
        const metaMatch = !!shortcut.meta === event.metaKey;

        if (keyMatch && ctrlMatch && shiftMatch && altMatch && metaMatch) {
          event.preventDefault();
          shortcut.handler();
          break;
        }
      }
    },
    [shortcuts],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}

// Common shortcuts
export const COMMON_SHORTCUTS: Omit<ShortcutConfig, "handler">[] = [
  {
    key: "k",
    ctrl: true,
    description: "Open command palette",
    scope: "global",
  },
  { key: "Enter", ctrl: true, description: "Send message", scope: "chat" },
  { key: "Escape", description: "Close modal / Cancel", scope: "global" },
  {
    key: "?",
    shift: true,
    description: "Show keyboard shortcuts",
    scope: "global",
  },
  { key: "r", ctrl: true, description: "Restart agent", scope: "global" },
  { key: " ", description: "Pause/Resume agent", scope: "global" },
  {
    key: "t",
    ctrl: true,
    shift: true,
    description: "Toggle terminal",
    scope: "global",
  },
];

// Hook to get shortcuts display
export function useShortcutsHelp(): string {
  return COMMON_SHORTCUTS.map(
    (s) => `${formatShortcut(s)} — ${s.description}`,
  ).join("\n");
}

function formatShortcut(s: Omit<ShortcutConfig, "handler">): string {
  const parts: string[] = [];
  if (s.ctrl) parts.push("Ctrl");
  if (s.shift) parts.push("Shift");
  if (s.alt) parts.push("Alt");
  if (s.meta) parts.push("Cmd");
  parts.push(s.key.length === 1 ? s.key.toUpperCase() : s.key);
  return parts.join("+");
}
