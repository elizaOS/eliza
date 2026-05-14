export interface ShortcutDescriptor {
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  description: string;
  scope?: string;
}

// Common shortcuts — app-specific definitions
export const COMMON_SHORTCUTS: ShortcutDescriptor[] = [
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
