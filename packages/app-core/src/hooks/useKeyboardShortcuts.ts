export {
  formatShortcut,
  type ShortcutConfig,
  useKeyboardShortcuts,
} from "@elizaos/app-core";

import type { ShortcutConfig } from "@elizaos/app-core";
import { formatShortcut } from "@elizaos/app-core";

// Common shortcuts — app-specific definitions
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
