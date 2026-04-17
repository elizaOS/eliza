/**
 * Browser-safe entry point for renderer bundles.
 *
 * Keep this surface aligned with `src/index.ts`, but do not re-export modules
 * that require Node APIs or server-only runtime state.
 */

export type { RestartHandler } from "@elizaos/shared/restart";
export {
  RESTART_EXIT_CODE,
  requestRestart,
  setRestartHandler,
} from "@elizaos/shared/restart";
export * from "@elizaos/ui";
export { App } from "./App.tsx";
export * from "./api/auth.ts";
export * from "./api/compat-route-shared.ts";
export * from "./api/index.ts";
export * from "./api/response.ts";
export * from "./bridge/index.ts";
export * from "./character-catalog.ts";
export * from "./chat/index.ts";
export * from "./components/index.ts";
export * from "./config/index.ts";
export * from "./events/index.ts";
export * from "./hooks/useActivityEvents.ts";
export * from "./hooks/useBugReport.tsx";
export * from "./hooks/useCanvasWindow.ts";
export * from "./hooks/useChatAvatarVoiceBridge.ts";
export * from "./hooks/useContextMenu.ts";
export {
  COMMON_SHORTCUTS,
  useShortcutsHelp,
} from "./hooks/useKeyboardShortcuts.ts";
export * from "./hooks/useMediaQuery.ts";
export * from "./hooks/useMusicPlayer.ts";
export * from "./hooks/useRenderGuard.ts";
export * from "./hooks/useSignalPairing.ts";
export * from "./hooks/useStreamPopoutNavigation.ts";
export * from "./hooks/useVoiceChat.ts";
export * from "./hooks/useWhatsAppPairing.ts";
export * from "./i18n/index.ts";
export * from "./navigation/index.ts";
export * from "./onboarding/connection-flow.ts";
export * from "./onboarding/flow.ts";
export * from "./onboarding/types.ts";
export * from "./platform/index.ts";
export * from "./security/agent-vault-id.ts";
export * from "./security/platform-secure-store.ts";
export * from "./shell/index.ts";
export * from "./state/index.ts";
export * from "./types/index.ts";
export * from "./utils/index.ts";
export * from "./voice/index.ts";
