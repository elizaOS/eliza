/**
 * ComputerUseService — long-lived service managing desktop automation,
 * browser control, and screenshot capabilities.
 *
 * Registered as serviceType "computeruse". Actions call into this service
 * to perform platform operations.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import type {
  ActionHistoryEntry,
  ApprovalMode,
  ApprovalResolution,
  ApprovalSnapshot,
  BrowserActionParams,
  BrowserActionResult,
  ComputerActionResult,
  ComputerUseConfig,
  DesktopActionParams,
  PlatformCapabilities,
  ScreenSize,
  WindowActionParams,
  WindowActionResult,
} from "../types.js";
import {
  ComputerUseApprovalManager,
  isApprovalMode,
} from "../approval-manager.js";
import {
  desktopClick,
  desktopDoubleClick,
  desktopDrag,
  desktopKeyCombo,
  desktopKeyPress,
  desktopMouseMove,
  desktopRightClick,
  desktopScroll,
  desktopType,
} from "../platform/desktop.js";
import { captureScreenshot } from "../platform/screenshot.js";
import {
  closeWindow,
  focusWindow,
  getScreenSize,
  listWindows,
  maximizeWindow,
  minimizeWindow,
} from "../platform/windows-list.js";
import {
  clickBrowser,
  closeBrowser,
  executeBrowser,
  getBrowserClickables,
  getBrowserDom,
  getBrowserState,
  isBrowserAvailable,
  listBrowserTabs,
  navigateBrowser,
  openBrowser,
  openBrowserTab,
  closeBrowserTab,
  screenshotBrowser,
  scrollBrowser,
  switchBrowserTab,
  typeBrowser,
} from "../platform/browser.js";
import { commandExists, currentPlatform } from "../platform/helpers.js";

const MAX_RECENT_ACTIONS = 10;

export class ComputerUseService extends Service {
  static serviceType = "computeruse";
  capabilityDescription = "Desktop automation — screenshots, mouse/keyboard control, browser CDP, window management";

  private capabilities!: PlatformCapabilities;
  private recentActions: ActionHistoryEntry[] = [];
  private screenSize: ScreenSize = { width: 1920, height: 1080 };
  private approvalManager = new ComputerUseApprovalManager();
  private cuConfig: ComputerUseConfig = {
    screenshotAfterAction: true,
    actionTimeoutMs: 10000,
    maxRecentActions: MAX_RECENT_ACTIONS,
    approvalMode: "full_control",
  };

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const instance = new ComputerUseService(runtime);
    instance.capabilities = instance.detectCapabilities();
    instance.loadConfig(runtime);

    try {
      instance.screenSize = getScreenSize();
    } catch (err) {
      logger.warn(`[computeruse] Could not detect screen size, using defaults: ${String(err)}`);
    }

    logger.info(
      `[computeruse] Service started — platform=${currentPlatform()} screen=${instance.screenSize.width}x${instance.screenSize.height} approval=${instance.getApprovalMode()}`,
    );

    // Log warnings for missing tools
    if (!instance.capabilities.screenshot.available) {
      logger.warn(`[computeruse] Screenshot not available: ${instance.capabilities.screenshot.tool}`);
    }
    if (!instance.capabilities.computerUse.available) {
      logger.warn(`[computeruse] Mouse/keyboard not available: ${instance.capabilities.computerUse.tool}`);
    }

    return instance;
  }

  async stop(): Promise<void> {
    this.approvalManager.cancelAll("computer-use service stopped");
    try {
      await closeBrowser();
    } catch { /* ignore */ }
    logger.info("[computeruse] Service stopped");
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async executeDesktopAction(params: DesktopActionParams): Promise<ComputerActionResult> {
    const entry: ActionHistoryEntry = {
      action: params.action,
      timestamp: Date.now(),
      params: this.toParamsRecord(params),
      success: false,
    };

    try {
      const approvalError = await this.awaitApproval(
        this.getDesktopCommandName(params),
        this.toParamsRecord(params),
      );
      if (approvalError) {
        this.pushAction(entry);
        return { success: false, error: approvalError };
      }

      switch (params.action) {
        case "screenshot":
          // Handled below — just capture screenshot
          break;
        case "click":
          this.requireCoordinate(params);
          desktopClick(params.coordinate![0], params.coordinate![1]);
          break;
        case "double_click":
          this.requireCoordinate(params);
          desktopDoubleClick(params.coordinate![0], params.coordinate![1]);
          break;
        case "right_click":
          this.requireCoordinate(params);
          desktopRightClick(params.coordinate![0], params.coordinate![1]);
          break;
        case "mouse_move":
          this.requireCoordinate(params);
          desktopMouseMove(params.coordinate![0], params.coordinate![1]);
          break;
        case "type":
          if (!params.text) throw new Error("text is required for type action");
          desktopType(params.text);
          break;
        case "key":
          if (!params.key) throw new Error("key is required for key action");
          desktopKeyPress(params.key);
          break;
        case "key_combo":
          if (!params.key) throw new Error("key is required for key_combo action (e.g. 'ctrl+c')");
          desktopKeyCombo(params.key);
          break;
        case "scroll":
          this.requireCoordinate(params);
          desktopScroll(
            params.coordinate![0],
            params.coordinate![1],
            params.scrollDirection ?? "down",
            params.scrollAmount ?? 3,
          );
          break;
        case "drag":
          if (!params.startCoordinate) throw new Error("startCoordinate is required for drag action");
          this.requireCoordinate(params);
          desktopDrag(
            params.startCoordinate[0], params.startCoordinate[1],
            params.coordinate![0], params.coordinate![1],
          );
          break;
        default:
          throw new Error(`Unknown desktop action: ${params.action}`);
      }

      // Capture screenshot after action (or as the action itself)
      let screenshot: string | undefined;
      if (params.action === "screenshot" || this.cuConfig.screenshotAfterAction) {
        try {
          const buf = captureScreenshot();
          screenshot = buf.toString("base64");
        } catch (err) {
          logger.warn(`[computeruse] Screenshot capture failed after action: ${String(err)}`);
        }
      }

      entry.success = true;
      this.pushAction(entry);
      return { success: true, screenshot };
    } catch (err) {
      entry.success = false;
      this.pushAction(entry);
      return { success: false, error: String(err) };
    }
  }

  async executeBrowserAction(params: BrowserActionParams): Promise<BrowserActionResult> {
    const entry: ActionHistoryEntry = {
      action: `browser_${params.action}`,
      timestamp: Date.now(),
      params: this.toParamsRecord(params),
      success: false,
    };

    try {
      const approvalError = await this.awaitApproval(
        this.getBrowserCommandName(params),
        this.toParamsRecord(params),
      );
      if (approvalError) {
        this.pushAction(entry);
        return { success: false, error: approvalError };
      }

      let result: BrowserActionResult;

      switch (params.action) {
        case "open": {
          const state = await openBrowser(params.url);
          result = { success: true, content: `Opened browser: ${state.url} — ${state.title}` };
          break;
        }
        case "close":
          await closeBrowser();
          result = { success: true, content: "Browser closed." };
          break;
        case "navigate": {
          if (!params.url) throw new Error("url is required for navigate action");
          const state = await navigateBrowser(params.url);
          result = { success: true, content: `Navigated to: ${state.url} — ${state.title}` };
          break;
        }
        case "click":
          await clickBrowser(params.selector, params.coordinate, params.text);
          result = { success: true, content: "Clicked." };
          break;
        case "type":
          if (!params.text) throw new Error("text is required for type action");
          await typeBrowser(params.text, params.selector);
          result = { success: true, content: "Typed text." };
          break;
        case "scroll":
          await scrollBrowser(params.direction ?? "down", params.amount ?? 300);
          result = { success: true, content: `Scrolled ${params.direction ?? "down"}.` };
          break;
        case "screenshot": {
          const b64 = await screenshotBrowser();
          result = { success: true, screenshot: b64 };
          break;
        }
        case "dom": {
          const html = await getBrowserDom();
          result = { success: true, content: html };
          break;
        }
        case "clickables": {
          const elements = await getBrowserClickables();
          result = { success: true, data: elements, content: JSON.stringify(elements, null, 2) };
          break;
        }
        case "execute": {
          if (!params.code) throw new Error("code is required for execute action");
          const output = await executeBrowser(params.code);
          result = { success: true, content: output };
          break;
        }
        case "state": {
          const state = await getBrowserState();
          result = { success: true, content: `URL: ${state.url}\nTitle: ${state.title}` };
          break;
        }
        case "list_tabs": {
          const tabs = await listBrowserTabs();
          result = { success: true, data: tabs, content: JSON.stringify(tabs, null, 2) };
          break;
        }
        case "open_tab": {
          const tab = await openBrowserTab(params.url);
          result = { success: true, content: `Opened tab: ${tab.url}`, data: tab };
          break;
        }
        case "close_tab": {
          if (!params.tabId) throw new Error("tabId is required for close_tab");
          await closeBrowserTab(params.tabId);
          result = { success: true, content: `Closed tab ${params.tabId}.` };
          break;
        }
        case "switch_tab": {
          if (!params.tabId) throw new Error("tabId is required for switch_tab");
          const state = await switchBrowserTab(params.tabId);
          result = { success: true, content: `Switched to tab: ${state.url}` };
          break;
        }
        default:
          throw new Error(`Unknown browser action: ${params.action}`);
      }

      entry.success = true;
      this.pushAction(entry);
      return result;
    } catch (err) {
      entry.success = false;
      this.pushAction(entry);
      return { success: false, error: String(err) };
    }
  }

  async executeWindowAction(params: WindowActionParams): Promise<WindowActionResult> {
    const entry: ActionHistoryEntry = {
      action: `window_${params.action}`,
      timestamp: Date.now(),
      params: this.toParamsRecord(params),
      success: false,
    };

    try {
      const approvalError = await this.awaitApproval(
        this.getWindowCommandName(params),
        this.toParamsRecord(params),
      );
      if (approvalError) {
        this.pushAction(entry);
        return { success: false, error: approvalError };
      }

      switch (params.action) {
        case "list": {
          const windows = listWindows();
          entry.success = true;
          this.pushAction(entry);
          return { success: true, windows };
        }
        case "focus":
          if (!params.windowId) throw new Error("windowId is required for focus");
          focusWindow(params.windowId);
          break;
        case "minimize":
          if (!params.windowId) throw new Error("windowId is required for minimize");
          minimizeWindow(params.windowId);
          break;
        case "maximize":
          if (!params.windowId) throw new Error("windowId is required for maximize");
          maximizeWindow(params.windowId);
          break;
        case "close":
          if (!params.windowId) throw new Error("windowId is required for close");
          closeWindow(params.windowId);
          break;
        default:
          throw new Error(`Unknown window action: ${params.action}`);
      }

      entry.success = true;
      this.pushAction(entry);
      return { success: true };
    } catch (err) {
      entry.success = false;
      this.pushAction(entry);
      return { success: false, error: String(err) };
    }
  }

  async captureScreen(): Promise<Buffer> {
    return captureScreenshot();
  }

  getCapabilities(): PlatformCapabilities {
    return this.capabilities;
  }

  getRecentActions(): ActionHistoryEntry[] {
    return [...this.recentActions];
  }

  getScreenDimensions(): ScreenSize {
    return this.screenSize;
  }

  getApprovalMode(): ApprovalMode {
    return this.approvalManager.getMode();
  }

  setApprovalMode(mode: ApprovalMode): ApprovalMode {
    const nextMode = this.approvalManager.setMode(mode);
    this.cuConfig.approvalMode = nextMode;
    logger.info(`[computeruse] Approval mode set to ${nextMode}`);
    return nextMode;
  }

  getApprovalSnapshot(): ApprovalSnapshot {
    return this.approvalManager.getSnapshot();
  }

  resolveApproval(
    id: string,
    approved: boolean,
    reason?: string,
  ): ApprovalResolution | null {
    return this.approvalManager.resolveApproval(id, approved, reason);
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private requireCoordinate(params: DesktopActionParams): void {
    if (!params.coordinate || params.coordinate.length < 2) {
      throw new Error(`coordinate [x, y] is required for ${params.action} action`);
    }
  }

  private getDesktopCommandName(params: DesktopActionParams): string {
    if (params.action === "key") {
      return "key_press";
    }
    return params.action;
  }

  private getBrowserCommandName(params: BrowserActionParams): string {
    return `browser_${params.action}`;
  }

  private getWindowCommandName(params: WindowActionParams): string {
    switch (params.action) {
      case "list":
        return "list_windows";
      case "focus":
        return "switch_to_window";
      case "minimize":
        return "minimize_window";
      case "maximize":
        return "maximize_window";
      case "close":
        return "close_window";
    }
  }

  private async awaitApproval(
    command: string,
    parameters: Record<string, unknown>,
  ): Promise<string | null> {
    if (this.approvalManager.shouldAutoApprove(command)) {
      return null;
    }

    if (this.approvalManager.isDenyAll()) {
      return `Computer use is paused. "${command}" was blocked by approval mode "${this.approvalManager.getMode()}".`;
    }

    const decision = await this.approvalManager.requestApproval(
      command,
      parameters,
    );
    if (decision.approved) {
      return null;
    }

    if (decision.cancelled) {
      return decision.reason
        ? `Computer-use approval cancelled: ${decision.reason}`
        : `Computer-use approval cancelled for "${command}".`;
    }

    return decision.reason
      ? `Computer-use approval rejected: ${decision.reason}`
      : `Computer-use approval rejected for "${command}".`;
  }

  private toParamsRecord(value: object): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
    );
  }

  private pushAction(entry: ActionHistoryEntry): void {
    this.recentActions.push(entry);
    if (this.recentActions.length > this.cuConfig.maxRecentActions) {
      this.recentActions.shift();
    }
  }

  private loadConfig(runtime: IAgentRuntime): void {
    const getSetting = (key: string): string | undefined => {
      try {
        return runtime.getSetting(key) as string | undefined;
      } catch {
        return undefined;
      }
    };

    const screenshotAfter = getSetting("COMPUTER_USE_SCREENSHOT_AFTER_ACTION");
    if (screenshotAfter !== undefined) {
      this.cuConfig.screenshotAfterAction = screenshotAfter !== "false" && screenshotAfter !== "0";
    }

    const timeout = getSetting("COMPUTER_USE_ACTION_TIMEOUT_MS");
    if (timeout) {
      const n = Number.parseInt(timeout, 10);
      if (Number.isFinite(n) && n > 0) {
        this.cuConfig.actionTimeoutMs = n;
      }
    }

    const approvalMode = getSetting("COMPUTER_USE_APPROVAL_MODE");
    if (approvalMode && isApprovalMode(approvalMode)) {
      this.cuConfig.approvalMode = approvalMode;
      this.approvalManager.setMode(approvalMode);
    }
  }

  private detectCapabilities(): PlatformCapabilities {
    const os = currentPlatform();
    const caps: PlatformCapabilities = {
      screenshot: { available: false, tool: "none" },
      computerUse: { available: false, tool: "none" },
      windowList: { available: false, tool: "none" },
      browser: { available: false, tool: "none" },
    };

    // Screenshot
    if (os === "darwin") {
      caps.screenshot = { available: true, tool: "screencapture (built-in)" };
    } else if (os === "linux") {
      if (commandExists("import")) caps.screenshot = { available: true, tool: "ImageMagick import" };
      else if (commandExists("scrot")) caps.screenshot = { available: true, tool: "scrot" };
      else if (commandExists("gnome-screenshot")) caps.screenshot = { available: true, tool: "gnome-screenshot" };
      else caps.screenshot = { available: false, tool: "none (install ImageMagick, scrot, or gnome-screenshot)" };
    } else if (os === "win32") {
      caps.screenshot = { available: true, tool: "PowerShell System.Drawing" };
    }

    // Mouse/keyboard
    if (os === "darwin") {
      caps.computerUse = commandExists("cliclick")
        ? { available: true, tool: "cliclick" }
        : { available: true, tool: "AppleScript (limited)" };
    } else if (os === "linux") {
      caps.computerUse = commandExists("xdotool")
        ? { available: true, tool: "xdotool" }
        : { available: false, tool: "none (install xdotool)" };
    } else if (os === "win32") {
      caps.computerUse = { available: true, tool: "PowerShell user32.dll" };
    }

    // Window list
    if (os === "darwin") {
      caps.windowList = { available: true, tool: "AppleScript System Events" };
    } else if (os === "linux") {
      if (commandExists("wmctrl")) caps.windowList = { available: true, tool: "wmctrl" };
      else if (commandExists("xdotool")) caps.windowList = { available: true, tool: "xdotool" };
      else caps.windowList = { available: false, tool: "none (install wmctrl or xdotool)" };
    } else if (os === "win32") {
      caps.windowList = { available: true, tool: "PowerShell Get-Process" };
    }

    // Browser
    caps.browser = isBrowserAvailable()
      ? { available: true, tool: "puppeteer-core (Chromium detected)" }
      : { available: false, tool: "none (no Chrome/Edge/Brave found)" };

    return caps;
  }
}
