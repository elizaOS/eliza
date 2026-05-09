/**
 * @elizaos/plugin-computeruse
 *
 * Desktop automation plugin for elizaOS agents — screenshots, mouse/keyboard
 * control, browser CDP automation, terminal access, file operations, and
 * window management.
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
import { desktopAction } from "./actions/desktop.js";
import { useComputerAction } from "./actions/use-computer.js";
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
    "automate web browsers via CDP, manage desktop windows, read/write files, and use a local terminal. " +
    "Ported from open-computer-use (Apache 2.0).",

  // biome-ignore lint/suspicious/noExplicitAny: ElizaOS Plugin type expects Service[] but our class uses static start()
  services: [ComputerUseService as any],

  // COMPUTER_USE (canonical desktop interaction: screenshot/click/key/etc.)
  // and DESKTOP (parent action dispatching file/window/terminal ops) stay
  // registered as distinct top-level actions — they cover different surfaces.
  actions: [useComputerAction, desktopAction],

  providers: [computerStateProvider],

  routes: computerUseRoutes,

  autoEnable: {
    envKeys: ["COMPUTER_USE_ENABLED"],
  },
};

export const computerusePlugin = computerUsePlugin;

export default computerUsePlugin;

export { ComputerUseService } from "./services/computer-use-service.js";
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
