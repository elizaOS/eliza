/**
 * Global keyboard-shortcut registry: descriptors with stable ids reported to the
 * agent as SHORTCUT_FIRED, matched against keydown and scoped per surface.
 */
export interface ShortcutDescriptor {
  /** Stable kebab-case id reported to the agent as SHORTCUT_FIRED (#8792). */
  id: string;
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
  meta?: boolean;
  description: string;
  scope?: string;
}

// Stable shortcut ids that report to the agent (intent-bearing moments only —
// see reportShortcutFired). Exported so handlers and tests share one source.
export const SHORTCUT_OPEN_COMMAND_PALETTE = "open-command-palette";
export const SHORTCUT_SHOW_KEYBOARD_SHORTCUTS = "show-keyboard-shortcuts";

// Common shortcuts — app-specific definitions
export const COMMON_SHORTCUTS: ShortcutDescriptor[] = [
  {
    id: SHORTCUT_OPEN_COMMAND_PALETTE,
    key: "k",
    ctrl: true,
    description: "Open command palette",
    scope: "global",
  },
  {
    id: "send-message",
    key: "Enter",
    description: "Send message",
    scope: "chat",
  },
  {
    id: "close-modal",
    key: "Escape",
    description: "Close modal / Cancel",
    scope: "global",
  },
  {
    id: SHORTCUT_SHOW_KEYBOARD_SHORTCUTS,
    key: "?",
    shift: true,
    description: "Show keyboard shortcuts",
    scope: "global",
  },
  {
    id: "focus-composer",
    key: "/",
    description: "Focus chat composer",
    scope: "global",
  },
];
