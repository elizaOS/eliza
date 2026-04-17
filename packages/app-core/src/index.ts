/**
 * Public entry point for @elizaos/app-core — import from `@elizaos/app-core` only.
 */

export * from "@elizaos/ui";
export type { RestartHandler } from "@elizaos/shared/restart";
export {
  RESTART_EXIT_CODE,
  requestRestart,
  setRestartHandler,
} from "@elizaos/shared/restart";

export {
  DEFAULT_MAX_BODY_BYTES,
  readRequestBody,
  readRequestBodyBuffer,
} from "@elizaos/agent/api/http-helpers";

export * from "./api/auth";
export * from "./api/response";
export * from "./api/compat-route-shared";
export * from "./api/server-cloud-tts";
export * from "./api/index";

export * from "./bridge/index";
export * from "./config/index";
export { CHANNEL_PLUGIN_MAP } from "./runtime/channel-plugin-map";
export * from "./types/index";
export * from "./events/index";
export * from "./hooks/useActivityEvents";
export * from "./hooks/useBugReport";
export * from "./hooks/useChatAvatarVoiceBridge";
export * from "./hooks/useCanvasWindow";
export * from "./hooks/useContextMenu";
export { COMMON_SHORTCUTS, useShortcutsHelp } from "./hooks/useKeyboardShortcuts";
export * from "./hooks/useMediaQuery";
export * from "./hooks/useMusicPlayer";
export * from "./hooks/useRenderGuard";
export * from "./hooks/useSignalPairing";
export * from "./hooks/useStreamPopoutNavigation";
export * from "./hooks/useVoiceChat";
export * from "./hooks/useWhatsAppPairing";
export * from "./i18n/index";
export * from "./navigation/index";
export * from "./platform/index";
export * from "./shell/index";
export * from "./voice/index";
export * from "./chat/index";
export * from "./state/index";
export * from "./utils/index";

export * from "./character-catalog";

export * from "./security/platform-secure-store";
export * from "./security/agent-vault-id";
export * from "./security/platform-secure-store-node";

export * from "./services/steward-sidecar";

export * from "./onboarding/flow";
export * from "./onboarding/types";
export * from "./onboarding/connection-flow";

export * from "./test-support/test-helpers";

export { App } from "./App.tsx";
export * from "./components/index";
