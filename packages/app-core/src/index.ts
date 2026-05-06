/**
 * Public entry point for @elizaos/app-core — import from `@elizaos/app-core` only.
 */

export {
  DEFAULT_MAX_BODY_BYTES,
  readRequestBody,
  readRequestBodyBuffer,
} from "@elizaos/agent";
export type { RestartHandler } from "@elizaos/shared";
export {
  RESTART_EXIT_CODE,
  requestRestart,
  setRestartHandler,
} from "@elizaos/shared";
export * from "@elizaos/ui";
export { App } from "./App.tsx";
export * from "./account-pool.js";
export * from "./api/auth";
export * from "./api/compat-route-shared";
export * from "./api/index";
export * from "./api/response";
export * from "./api/server-cloud-tts";
export {
  type AppShellPageRegistration,
  listAppShellPages,
  registerAppShellPage,
} from "./app-shell-components";
export * from "./bridge/index";
export * from "./chat/index";
export * from "./components/index";
export type { TranslatorFn } from "./components/shared/LanguageDropdown";
export type {
  CompanionInferenceNotice,
  CompanionSceneStatus,
} from "./config/boot-config";
export * from "./config/index";
export * from "./desktop-runtime/index";
export * from "./events/index";
export * from "./hooks/useActivityEvents";
export * from "./hooks/useBugReport";
export * from "./hooks/useChatAvatarVoiceBridge";
export * from "./hooks/useContextMenu";
export {
  COMMON_SHORTCUTS,
  useShortcutsHelp,
} from "./hooks/useKeyboardShortcuts";
export * from "./hooks/useMediaQuery";
export * from "./hooks/useRenderGuard";
export * from "./hooks/useSignalPairing";
export * from "./hooks/useStreamPopoutNavigation";
export * from "./hooks/useVoiceChat";
export * from "./hooks/useWhatsAppPairing";
export * from "./i18n/index";
export * from "./navigation/index";
export * from "./onboarding/flow";
export * from "./onboarding/mobile-runtime-mode";
export * from "./onboarding/pre-seed-local-runtime";
export * from "./onboarding/reload-into-runtime-picker";
export * from "./onboarding/server-target";
export * from "./platform/index";
export { CHANNEL_PLUGIN_MAP } from "./runtime/channel-plugin-map";
export * from "./security/agent-vault-id";
export * from "./security/platform-secure-store";
export * from "./security/platform-secure-store-node";
export * from "./slots/task-coordinator-slots";
export * from "./state/index";
export * from "./test-support/test-helpers";
export * from "./types/index";
export * from "./utils/index";
export * from "./voice/index";
export * from "./widgets/index";
