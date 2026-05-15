/**
 * @elizaos/plugin-computeruse
 *
 * Desktop automation plugin for elizaOS agents — screenshots, mouse/keyboard
 * control, browser CDP automation, and window management.
 *
 * File operations belong on the FILE action; shell/terminal access belongs on
 * the SHELL action. They are not exposed by this plugin.
 *
 * Deeply ported from coasty-ai/open-computer-use (Apache 2.0).
 *
 * Enable via:
 *   - Config: features.computeruse: true
 *   - Env: COMPUTER_USE_ENABLED=1
 *
 * Platform requirements:
 *   macOS  — screencapture (built-in), cliclick (brew install cliclick), AppleScript
 *   Linux  — xdotool (sudo apt install xdotool), ImageMagick/scrot for screenshots
 *   Windows — PowerShell (built-in)
 *   Browser — puppeteer-core + Chrome/Edge/Brave installed
 *
 * @module @elizaos/plugin-computeruse
 */

import type { Plugin, Route } from "@elizaos/core";
import { promoteSubactionsToActions } from "@elizaos/core";
import { useComputerAction } from "./actions/use-computer.js";
import { computerUseAgentAction } from "./actions/use-computer-agent.js";
import { windowAction } from "./actions/window.js";
import { computerStateProvider } from "./providers/computer-state.js";
import { sceneProvider } from "./providers/scene.js";
import { computerUseRouteHandler } from "./routes/computer-use-compat-routes.js";
import { ComputerUseService } from "./services/computer-use-service.js";
import { VisionContextProvider } from "./services/vision-context-provider.js";

const computerUseRoutes: Route[] = [
  {
    type: "GET",
    path: "/api/computer-use/approvals",
    rawPath: true,
    handler: computerUseRouteHandler(),
  },
  {
    type: "GET",
    path: "/api/computer-use/approvals/stream",
    rawPath: true,
    public: true,
    name: "computeruse-approvals-stream",
    handler: computerUseRouteHandler(),
  },
  {
    type: "POST",
    path: "/api/computer-use/approval-mode",
    rawPath: true,
    handler: computerUseRouteHandler(),
  },
  {
    // Dynamic `:id` segment — handler decodes the id from req.url itself.
    type: "POST",
    path: "/api/computer-use/approvals/:id",
    rawPath: true,
    handler: computerUseRouteHandler(),
  },
];

export const computerUsePlugin: Plugin = {
  name: "@elizaos/plugin-computeruse",
  description:
    "Desktop automation — take screenshots, control mouse and keyboard, " +
    "automate web browsers via CDP, and manage desktop windows. " +
    "Ported from open-computer-use (Apache 2.0).",

  services: [ComputerUseService, VisionContextProvider],

  // COMPUTER_USE (canonical desktop interaction: screenshot/click/key/etc.)
  // and WINDOW (window management: list/focus/switch/arrange/move/...) stay
  // registered as distinct top-level actions — they cover different surfaces.
  // Each umbrella's subactions are promoted to virtual top-level actions
  // (e.g. COMPUTER_USE_CLICK, WINDOW_FOCUS) so the planner can pick a
  // specific verb directly from the action catalogue.
  actions: [
    ...promoteSubactionsToActions(useComputerAction),
    ...promoteSubactionsToActions(windowAction),
    computerUseAgentAction,
  ],

  providers: [computerStateProvider, sceneProvider],

  routes: computerUseRoutes,

  autoEnable: {
    envKeys: ["COMPUTER_USE_ENABLED"],
  },
};

export const computerusePlugin = computerUsePlugin;

export default computerUsePlugin;

export {
  type ComputerUseAgentParams,
  type ComputerUseAgentReport,
  computerUseAgentAction,
  runComputerUseAgentLoop,
} from "./actions/use-computer-agent.js";
// WS7: Brain / Actor / Cascade / Dispatch — autonomous desktop loop.
export * from "./actor/index.js";
// iOS computer-use surface. See `docs/IOS_CONSTRAINTS.md` for the honest scope.
export * from "./mobile/index.js";
export {
  listProcesses,
  type ProcessInfo,
  parsePsOutput,
  parseWindowsProcessJson,
} from "./platform/process-list.js";
export { sceneProvider } from "./providers/scene.js";
export { handleComputerUseRoutes } from "./routes/computer-use-routes.js";
export { handleSandboxRoute } from "./routes/sandbox-routes.js";
export {
  type AccessibilityProvider,
  DarwinAccessibilityProvider,
  LinuxAccessibilityProvider,
  NullAccessibilityProvider,
  parseHyprlandClients,
  parseSwayTree,
  resolveAccessibilityProvider,
  setAccessibilityProvider,
  WindowsAccessibilityProvider,
} from "./scene/a11y-provider.js";
export { enumerateApps, joinAppsAndWindows } from "./scene/apps.js";
export {
  type BlockGrid,
  blockGrid,
  type DirtyBlock,
  decodePng,
  diffBlocks,
  frameDhash,
  hamming,
} from "./scene/dhash.js";
// WS6: scene-builder surface — consumed by WS7 (Brain) and WS10 verifiers.
export {
  _resetDefaultSceneBuilderForTests,
  getDefaultSceneBuilder,
  SceneBuilder,
  type SceneBuilderDeps,
  type SceneUpdateEvent,
} from "./scene/scene-builder.js";
export type {
  Scene,
  SceneApp,
  SceneAppWindow,
  SceneAxNode,
  SceneFocusedWindow,
  SceneOcrBox,
  SceneVlmElement,
} from "./scene/scene-types.js";
export { serializeSceneForPrompt } from "./scene/serialize.js";
export { ComputerUseService } from "./services/computer-use-service.js";
export type {
  DesktopControlCapabilities,
  DesktopControlCapability,
  DesktopInputButton,
  DesktopScreenshotRegion,
  DesktopWindowInfo,
} from "./services/desktop-control.js";
export {
  type VisionContext,
  type VisionContextBBox,
  type VisionContextFocusedWindow,
  type VisionContextRecentAction,
  VisionContextProvider,
  VISION_CONTEXT_SERVICE_TYPE,
  VISION_CONTEXT_TASK_GOAL_CACHE_KEY,
} from "./services/vision-context-provider.js";
export {
  captureDesktopScreenshot,
  commandExists,
  detectDesktopControlCapabilities,
  getDesktopPlatformName,
  isHeadfulGuiAvailable,
  listDesktopWindows,
  performDesktopClick,
  performDesktopDoubleClick,
  performDesktopKeypress,
  performDesktopMouseMove,
  performDesktopScroll,
  performDesktopTextInput,
} from "./services/desktop-control.js";
// Re-export types for consumers
export type {
  ActionHistoryEntry,
  ApprovalMode,
  ApprovalResolution,
  ApprovalSnapshot,
  BrowserActionParams,
  BrowserActionResult,
  BrowserActionType,
  BrowserInfo,
  BrowserState,
  BrowserTab,
  ClickableElement,
  ComputerActionResult,
  ComputerUseConfig,
  ComputerUseResult,
  DesktopActionParams,
  DesktopActionType,
  FileActionParams,
  FileActionResult,
  FileActionType,
  FileEntry,
  PendingApproval,
  PermissionType,
  PlatformCapabilities,
  ScreenRegion,
  ScreenSize,
  TerminalActionParams,
  TerminalActionResult,
  TerminalActionType,
  WindowActionParams,
  WindowActionResult,
  WindowActionType,
  WindowInfo,
} from "./types.js";
