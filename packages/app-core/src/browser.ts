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
export * from "./app-shell/task-coordinator-slots.tsx";
export * from "./components/apps/extensions/surface.tsx";
export * from "./components/apps/overlay-app-api.ts";
export * from "./components/apps/overlay-app-registry.ts";
export * from "./components/apps/surfaces/GameOperatorShell.tsx";
export * from "./components/apps/surfaces/registry.ts";
export { CharacterEditor } from "./components/character/CharacterEditor.tsx";
export * from "./components/character/character-greeting.ts";
export * from "./components/chat/widgets/shared.tsx";
export { WhatsAppQrOverlay } from "./components/connectors/WhatsAppQrOverlay.tsx";
export { getExplorerTokenUrl } from "./components/inventory/chainConfig.ts";
// Explicit named re-exports for the wallet helpers that renderer-side
// modules (e.g. apps/app-companion/.../walletUtils.ts) reach for. The
// wildcard re-export above should carry these, but Vite's dev-time module
// graph has been observed to miss symbols across nested `export *` chains
// under HMR, so naming them directly guarantees the binding.
export {
  BSC_GAS_READY_THRESHOLD,
  BSC_GAS_THRESHOLD,
  HEX_ADDRESS_RE,
  isAvaxChainName,
  isBscChainName,
  toNormalizedAddress,
} from "./components/inventory/constants.ts";
export * from "./components/inventory/index.ts";
export * from "./components/pages/ChatModalView.tsx";
export { PhoneCompanionApp } from "./components/phone-companion/PhoneCompanionApp.tsx";
export * from "./components/shared/LanguageDropdown.tsx";
export * from "./components/shared/ThemeToggle.tsx";
export * from "./components/workspace/AppWorkspaceChrome.tsx";
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
export * from "./onboarding/flow.ts";
export * from "./onboarding/mobile-runtime-mode.ts";
export * from "./onboarding/server-target.ts";
export * from "./platform/index.ts";
export * from "./security/agent-vault-id.ts";
export * from "./security/platform-secure-store.ts";
export * from "./shell/index.ts";
export * from "./state/CompanionSceneConfigContext.tsx";
export * from "./state/index.ts";
export * from "./types/index.ts";
export * from "./utils/index.ts";
export * from "./voice/index.ts";
