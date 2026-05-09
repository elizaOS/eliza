/**
 * Browser-safe entry point for renderer bundles.
 *
 * Keep this surface aligned with `src/index.ts`, but do not re-export modules
 * that require Node APIs or server-only runtime state.
 */

export { TokenLogo } from "@elizaos/app-wallet";
export { useInventoryData } from "@elizaos/app-wallet";
export type { RestartHandler } from "@elizaos/shared";
export {
  RESTART_EXIT_CODE,
  requestRestart,
  setRestartHandler,
} from "@elizaos/shared";
export * from "@elizaos/ui";
export { App } from "./App.tsx";
export * from "./api/index.ts";
export * from "./api/response.ts";
export * from "./bridge/index.ts";
export * from "./chat/index.ts";
export * from "./components/apps/extensions/registry.ts";
export * from "./components/apps/extensions/surface.tsx";
export * from "./components/apps/extensions/types.ts";
export * from "./components/apps/overlay-app-api.ts";
export * from "./components/apps/overlay-app-registry.ts";
export * from "./components/apps/surfaces/GameOperatorShell.tsx";
export * from "./components/apps/surfaces/registry.ts";
export * from "./components/apps/surfaces/types.ts";
export { CharacterEditor } from "./components/character/CharacterEditor.tsx";
export * from "./components/character/character-greeting.ts";
export * from "./components/chat/widgets/shared.tsx";
export * from "./components/config-ui/config-renderer.tsx";
export {
  evaluateUiVisibility,
  getSupportedComponents,
  runValidation as runUiValidation,
  sanitizeLinkHref,
  UiRenderer,
  type UiRendererProps,
} from "./components/config-ui/ui-renderer.tsx";
export * from "./components/pages/ChatModalView.tsx";
export * from "./components/pages/PageScopedChatPane.tsx";
export type { TranslatorFn } from "./components/shared/LanguageDropdown.tsx";
export * from "./components/shared/LanguageDropdown.tsx";
export * from "./components/shared/ThemeToggle.tsx";
export { LoadingScreen } from "./components/shell/LoadingScreen.tsx";
export * from "./components/workspace/AppWorkspaceChrome.tsx";
export * from "./config/app-config.ts";
export * from "./config/boot-config.ts";
export * from "./config/boot-config-react.tsx";
export type {
  CompanionInferenceNotice,
  CompanionSceneStatus,
} from "./config/boot-config-store.ts";
export * from "./config/branding.ts";
export * from "./config/cloud-only.ts";
export * from "./config/config-catalog.ts";
export * from "./config/index.ts";
export {
  buildPluginConfigUiSpec,
  buildPluginListUiSpec,
} from "./config/plugin-ui-spec.ts";
export * from "./config/ui-spec.ts";
export * from "./desktop-runtime/index.ts";
export * from "./events/index.ts";
export * from "./hooks/useActivityEvents.ts";
export * from "./hooks/useBugReport.tsx";
export * from "./hooks/useChatAvatarVoiceBridge.ts";
export * from "./hooks/useContextMenu.ts";
export {
  COMMON_SHORTCUTS,
  useShortcutsHelp,
} from "./hooks/useKeyboardShortcuts.ts";
export * from "./hooks/useMediaQuery.ts";
export * from "./hooks/useRenderGuard.ts";
export * from "./hooks/useSignalPairing.ts";
export * from "./hooks/useStreamPopoutNavigation.ts";
export * from "./hooks/useVoiceChat.ts";
export * from "./hooks/useWhatsAppPairing.ts";
export * from "./i18n/index.ts";
export * from "./navigation/index.ts";
export * from "./onboarding/flow.ts";
export * from "./onboarding/mobile-runtime-mode.ts";
export * from "./onboarding/pre-seed-local-runtime.ts";
export * from "./onboarding/reload-into-runtime-picker.ts";
export * from "./onboarding/server-target.ts";
export * from "./platform/index.ts";
export * from "./slots/task-coordinator-slots.tsx";
export * from "./state/CompanionSceneConfigContext.tsx";
export * from "./state/index.ts";
export * from "./types/index.ts";
export * from "./voice/index.ts";
export * from "./widgets/index.ts";
