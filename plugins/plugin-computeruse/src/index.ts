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

import type { Plugin } from "@elizaos/core";
import { browserAction } from "./actions/browser-action.js";
import { fileAction } from "./actions/file-action.js";
import { manageWindowAction } from "./actions/manage-window.js";
import { terminalAction } from "./actions/terminal-action.js";
import { useComputerAction } from "./actions/use-computer.js";
import { computerStateProvider } from "./providers/computer-state.js";
import { ComputerUseService } from "./services/computer-use-service.js";

export const computerUsePlugin: Plugin = {
  name: "@elizaos/plugin-computeruse",
  description:
    "Desktop automation — take screenshots, control mouse and keyboard, " +
    "automate web browsers via CDP, manage desktop windows, read/write files, and use a local terminal. " +
    "Ported from open-computer-use (Apache 2.0).",

  // biome-ignore lint/suspicious/noExplicitAny: ElizaOS Plugin type expects Service[] but our class uses static start()
  services: [ComputerUseService as any],

  actions: [
    useComputerAction,
    browserAction,
    manageWindowAction,
    fileAction,
    terminalAction,
  ],

  evaluators: [],

  providers: [computerStateProvider],

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
