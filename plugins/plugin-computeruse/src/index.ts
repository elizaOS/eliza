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
import { windowAction } from "./actions/window.js";
import { computerStateProvider } from "./providers/computer-state.js";
import { computerUseRouteHandler } from "./routes/computer-use-compat-routes.js";
import { ComputerUseService } from "./services/computer-use-service.js";

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

  services: [ComputerUseService],

  // COMPUTER_USE (canonical desktop interaction: screenshot/click/key/etc.)
  // and WINDOW (window management: list/focus/switch/arrange/move/...) stay
  // registered as distinct top-level actions — they cover different surfaces.
  // Each umbrella's subactions are promoted to virtual top-level actions
  // (e.g. COMPUTER_USE_CLICK, WINDOW_FOCUS) so the planner can pick a
  // specific verb directly from the action catalogue.
  actions: [
    ...promoteSubactionsToActions(useComputerAction),
    ...promoteSubactionsToActions(windowAction),
  ],

  providers: [computerStateProvider],

  routes: computerUseRoutes,

  autoEnable: {
    envKeys: ["COMPUTER_USE_ENABLED"],
  },
};

export const computerusePlugin = computerUsePlugin;

export default computerUsePlugin;

export { ComputerUseService } from "./services/computer-use-service.js";
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
export type {
  DesktopControlCapabilities,
  DesktopControlCapability,
  DesktopInputButton,
  DesktopScreenshotRegion,
  DesktopWindowInfo,
} from "./services/desktop-control.js";
export { handleComputerUseRoutes } from "./routes/computer-use-routes.js";
export { handleSandboxRoute } from "./routes/sandbox-routes.js";
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
