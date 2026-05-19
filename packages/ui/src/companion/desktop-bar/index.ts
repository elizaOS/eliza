export type { CompanionBarProps } from "./CompanionBar";
export { CompanionBar } from "./CompanionBar";
export {
  registerTrayIcon,
  type TrayHandle,
  type TrayRegistrationOptions,
} from "./platform";
export type {
  DesktopRuntimeHooks,
  DesktopTrayMode,
  MicState,
  TrayMessage,
} from "./types";
export {
  type KeyboardShortcutHandlers,
  type KeyboardShortcutOptions,
  type KeyboardShortcutsState,
  useKeyboardShortcuts,
} from "./useKeyboardShortcuts";
export {
  type PushToTalkHandlers,
  type PushToTalkOptions,
  type PushToTalkState,
  usePushToTalk,
} from "./usePushToTalk";
