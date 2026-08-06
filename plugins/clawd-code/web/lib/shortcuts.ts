export interface Command {
  id: string;
  /** One or more key combo strings, e.g. ["mod+k", "mod+shift+p"] */
  keys: string[];
  label: string;
  description: string;
  category: ShortcutCategory;
  action: () => void;
  /** Return false to disable this command contextually */
  when?: () => boolean;
  /** If true, fires even when an input/textarea is focused */
  global?: boolean;
  /** Icon name from lucide-react, optional */
  icon?: string;
}

export type ShortcutCategory =
  | "Chat"
  | "Navigation"
  | "Model"
  | "Theme"
  | "View"
  | "Help";

export const SHORTCUT_CATEGORIES: ShortcutCategory[] = [
  "Chat",
  "Navigation",
  "Model",
  "Theme",
  "View",
  "Help",
];

/** IDs for all default commands — used to register/look up */
export const CMD = {
  OPEN_PALETTE: "open-palette",
  NEW_CONVERSATION: "new-conversation",
  TOGGLE_SIDEBAR: "toggle-sidebar",
  OPEN_SETTINGS: "open-settings",
  SEND_MESSAGE: "send-message",
  STOP_GENERATION: "stop-generation",
  CLEAR_CONVERSATION: "clear-conversation",
  TOGGLE_THEME: "toggle-theme",
  PREV_CONVERSATION: "prev-conversation",
  NEXT_CONVERSATION: "next-conversation",
  FOCUS_CHAT: "focus-chat",
  SHOW_HELP: "show-help",
  GLOBAL_SEARCH: "global-search",
} as const;

export type CommandId = (typeof CMD)[keyof typeof CMD];
