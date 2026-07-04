/**
 * Barrel for the state layer: contexts, stores, persistence, parsers, and the
 * runtime-switch entry point consumed across the shell.
 */
export { AppProvider } from "./AppContext";
export { RESYNC_EVENT, type ResyncEventDetail } from "./AppContext.hooks";
export * from "./action-notice";
export * from "./agent-profiles";
export {
  __setAppValueForTests,
  publishAppValue,
  useAppSelector,
  useAppSelectorShallow,
} from "./app-store";
export * from "./ChatComposerContext.hooks";
export * from "./ChatTurnStatusContext.hooks";
export * from "./ConversationMessagesContext.hooks";
export * from "./internal";
export * from "./PtySessionsContext.hooks";
export * from "./parsers";
export * from "./persistence";
export type { SwitchRuntimeResult } from "./switch-runtime";
export { switchRuntimeNonDestructive } from "./switch-runtime";
export * from "./TranslationContext.hooks";
export { TranslationProvider } from "./TranslationProvider";
export * from "./types";
export * from "./ui-preferences";
export * from "./useApp";
export * from "./useBackgroundConfig";
export * from "./useChatOverlayHotkey";
export * from "./useContentPack";
export * from "./useDeveloperMode";
export * from "./usePreviewMode";
export * from "./useViewKinds";
export * from "./useWalletState";
export * from "./view-chat-binding";
