import os from "node:os";
import path from "node:path";
import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  ComputerUseApprovalManager,
  isApprovalMode,
} from "../approval-manager.js";
import {
  clickBrowser,
  closeBrowser,
  closeBrowserTab,
  executeBrowser,
  getBrowserClickables,
  getBrowserContext,
  getBrowserDom,
  getBrowserInfo,
  getBrowserState,
  isBrowserAvailable,
  listBrowserTabs,
  navigateBrowser,
  openBrowser,
  openBrowserTab,
  screenshotBrowser,
  scrollBrowser,
  setBrowserRuntimeOptions,
  switchBrowserTab,
  typeBrowser,
  waitBrowser,
} from "../platform/browser.js";
import { detectPlatformCapabilities } from "../platform/capabilities.js";
import {
  driverCaptureScreenshot,
  driverClick,
  driverClickWithModifiers,
  driverDoubleClick,
  driverDrag,
  driverKeyCombo,
  driverKeyPress,
  driverMouseMove,
  driverRightClick,
  driverScroll,
  driverType,
} from "../platform/driver.js";
import {
  appendFile,
  deleteDirectory,
  deleteFile,
  editFile,
  fileExists,
  listDirectory,
  readFile,
  writeFile,
} from "../platform/file-ops.js";
import { commandExists, currentPlatform } from "../platform/helpers.js";
import { classifyPermissionDeniedError } from "../platform/permissions.js";
import {
  clearTerminal,
  closeAllTerminalSessions,
  closeTerminal,
  connectTerminal,
  executeTerminal,
  readTerminal,
  typeTerminal,
} from "../platform/terminal.js";
import {
  arrangeWindows,
  closeWindow,
  focusWindow,
  getScreenSize,
  listWindows,
  maximizeWindow,
  minimizeWindow,
  moveWindow,
  restoreWindow,
  switchWindow,
} from "../platform/windows-list.js";
import type {
  ActionHistoryEntry,
  ApprovalMode,
  ApprovalResolution,
  ApprovalSnapshot,
  BrowserActionParams,
  BrowserActionResult,
  ComputerActionResult,
  ComputerUseConfig,
  ComputerUseResult,
  DesktopActionParams,
  FileActionParams,
  FileActionResult,
  PlatformCapabilities,
  ScreenSize,
  TerminalActionParams,
  TerminalActionResult,
  WindowActionParams,
  WindowActionResult,
} from "../types.js";

const MAX_RECENT_ACTIONS = 10;
const BROWSER_NOT_OPEN_ERROR = "Browser not open";
const BROWSER_LIFECYCLE_ACTIONS = new Set<BrowserActionParams["action"]>([
  "open",
  "connect",
  "close",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBrowserNotOpenMessage(message: unknown): boolean {
  return (
    typeof message === "string" && message.includes(BROWSER_NOT_OPEN_ERROR)
  );
}

function commandParameters<TParams extends object>(
  parameters: Record<string, unknown>,
): Omit<TParams, "action"> {
  return parameters as Omit<TParams, "action">;
}

function stringifyData(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return renderPlainData(value);
}

function renderPlainData(value: unknown, indent = 0): string {
  const prefix = "  ".repeat(indent);
  if (value === null || value === undefined) {
    return "none";
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "items[0]:";
    }
    return [
      `items[${value.length}]:`,
      ...value.map((item) => `${prefix}- ${renderPlainData(item, indent + 1)}`),
    ].join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, nestedValue]) => {
        if (nestedValue && typeof nestedValue === "object") {
          return `${key}:\n${renderPlainData(nestedValue, indent + 1)}`;
        }
        return `${key}: ${renderPlainData(nestedValue, indent + 1)}`;
      })
      .join("\n");
  }
  return String(value);
}

export class ComputerUseService extends Service {
  static serviceType = "computeruse";

  capabilityDescription =
    "Desktop automation, screenshots, browser control, file operations, terminal access, window management, and approval-gated local actions";

  private capabilities!: PlatformCapabilities;
  private recentActions: ActionHistoryEntry[] = [];
  private screenSize: ScreenSize = { width: 1920, height: 1080 };
  private approvalManager = new ComputerUseApprovalManager();
  private cuConfig: ComputerUseConfig = {
    screenshotAfterAction: true,
    actionTimeoutMs: 10000,
    maxRecentActions: MAX_RECENT_ACTIONS,
    approvalMode: "full_control",
    browserHeadless: false,
  };

  static async start(runtime: IAgentRuntime): Promise<Service> {
    const instance = new ComputerUseService(runtime);
    instance.loadConfig(runtime);
    instance.capabilities = instance.detectCapabilities();

    try {
      instance.screenSize = getScreenSize();
    } catch (error) {
      logger.warn(
        `[computeruse] Falling back to default screen size: ${errorMessage(error)}`,
      );
    }

    logger.info(
      `[computeruse] Service started on ${currentPlatform()} (${instance.screenSize.width}x${instance.screenSize.height}) approval=${instance.getApprovalMode()}`,
    );

    return instance;
  }

  async stop(): Promise<void> {
    this.approvalManager.cancelAll("computer-use service stopped");
    closeAllTerminalSessions();
    try {
      await closeBrowser();
    } catch {
      // ignore browser shutdown failures
    }
    logger.info("[computeruse] Service stopped");
  }

  async executeCommand(
    command: string,
    parameters: Record<string, unknown> = {},
  ): Promise<ComputerUseResult> {
    switch (command) {
      case "screenshot":
      case "click":
      case "click_with_modifiers":
      case "double_click":
      case "right_click":
      case "mouse_move":
      case "type":
      case "key_press":
      case "key_combo":
      case "scroll":
      case "drag":
      case "detect_elements":
      case "ocr":
        return this.executeDesktopAction({
          ...commandParameters<DesktopActionParams>(parameters),
          action: this.mapDesktopCommandToAction(command),
        });
      case "browser_open":
      case "browser_connect":
      case "browser_close":
      case "browser_navigate":
      case "browser_click":
      case "browser_type":
      case "browser_scroll":
      case "browser_screenshot":
      case "browser_dom":
      case "browser_get_dom":
      case "browser_clickables":
      case "browser_get_clickables":
      case "browser_execute":
      case "browser_state":
      case "browser_info":
      case "browser_get_context":
      case "browser_wait":
      case "browser_list_tabs":
      case "browser_open_tab":
      case "browser_close_tab":
      case "browser_switch_tab":
        return this.executeBrowserAction({
          ...commandParameters<BrowserActionParams>(parameters),
          action: this.mapBrowserCommandToAction(command),
        });
      case "list_windows":
      case "switch_to_window":
      case "arrange_windows":
      case "move_window":
      case "minimize_window":
      case "maximize_window":
      case "restore_window":
      case "close_window":
        return this.executeWindowAction({
          ...commandParameters<WindowActionParams>(parameters),
          action: this.mapWindowCommandToAction(command),
        });
      case "file_read":
      case "file_write":
      case "file_edit":
      case "file_append":
      case "file_delete":
      case "file_exists":
      case "directory_list":
      case "directory_delete":
      case "file_upload":
      case "file_download":
      case "file_list_downloads":
        return this.executeFileAction({
          ...commandParameters<FileActionParams>(parameters),
          action: this.mapFileCommandToAction(command),
        });
      case "terminal_connect":
      case "terminal_execute":
      case "terminal_read":
      case "terminal_type":
      case "terminal_clear":
      case "terminal_close":
      case "execute_command":
        return this.executeTerminalAction({
          ...commandParameters<TerminalActionParams>(parameters),
          action: this.mapTerminalCommandToAction(command),
        });
      default:
        return {
          success: false,
          error: `Unknown computer-use command: ${command}`,
        };
    }
  }

  async executeDesktopAction(
    rawParams: DesktopActionParams,
  ): Promise<ComputerActionResult> {
    const params = this.normalizeDesktopActionParams(rawParams);
    const entry = this.createEntry(params.action, this.toParamsRecord(params));

    try {
      const approvalError = await this.awaitApproval(
        this.desktopApprovalCommand(params.action),
        this.toParamsRecord(params),
      );
      if (approvalError) {
        return this.failEntry(entry, { success: false, error: approvalError });
      }

      if (params.action === "detect_elements") {
        return this.failEntry(entry, {
          success: false,
          error:
            "Element detection is not available on local machines. Use a screenshot plus model reasoning instead.",
        });
      }

      if (params.action === "ocr") {
        return this.failEntry(entry, {
          success: false,
          error:
            "OCR is not available on local machines. Use a screenshot plus model reasoning instead.",
        });
      }

      switch (params.action) {
        case "screenshot":
          return this.succeedEntry(entry, {
            success: true,
            screenshot: await this.captureScreenshotBase64(),
          });
        case "click":
          this.requireCoordinate(params.coordinate, "click");
          await driverClick(params.coordinate[0], params.coordinate[1]);
          break;
        case "click_with_modifiers":
          this.requireCoordinate(params.coordinate, "click_with_modifiers");
          await driverClickWithModifiers(
            params.coordinate[0],
            params.coordinate[1],
            params.modifiers ?? [],
          );
          break;
        case "double_click":
          this.requireCoordinate(params.coordinate, "double_click");
          await driverDoubleClick(params.coordinate[0], params.coordinate[1]);
          break;
        case "right_click":
          this.requireCoordinate(params.coordinate, "right_click");
          await driverRightClick(params.coordinate[0], params.coordinate[1]);
          break;
        case "mouse_move":
          this.requireCoordinate(params.coordinate, "mouse_move");
          await driverMouseMove(params.coordinate[0], params.coordinate[1]);
          break;
        case "type":
          if (!params.text) throw new Error("text is required for type action");
          await driverType(params.text);
          break;
        case "key":
          if (!params.key) throw new Error("key is required for key action");
          await driverKeyPress(params.key);
          break;
        case "key_combo":
          if (!params.key) {
            throw new Error("key is required for key_combo action");
          }
          await driverKeyCombo(params.key);
          break;
        case "scroll":
          this.requireCoordinate(params.coordinate, "scroll");
          await driverScroll(
            params.coordinate[0],
            params.coordinate[1],
            params.scrollDirection ?? "down",
            params.scrollAmount ?? 3,
          );
          break;
        case "drag":
          this.requireCoordinate(
            params.startCoordinate,
            "drag",
            "startCoordinate",
          );
          this.requireCoordinate(params.coordinate, "drag");
          await driverDrag(
            params.startCoordinate[0],
            params.startCoordinate[1],
            params.coordinate[0],
            params.coordinate[1],
          );
          break;
        default:
          return this.failEntry(entry, {
            success: false,
            error: `Unknown desktop action: ${(params as { action: string }).action}`,
          });
      }

      const result: ComputerActionResult = { success: true };
      if (this.shouldCaptureAfterDesktopAction(params.action)) {
        try {
          result.screenshot = await this.captureScreenshotBase64();
        } catch (error) {
          logger.warn(
            `[computeruse] Post-action screenshot failed: ${errorMessage(error)}`,
          );
        }
      }
      return this.succeedEntry(entry, result);
    } catch (error) {
      const permissionError = classifyPermissionDeniedError(error, {
        permissionType:
          params.action === "screenshot" ? "screen_recording" : "accessibility",
        operation: params.action,
      });
      if (permissionError) {
        return this.failEntry(entry, {
          success: false,
          error: permissionError.message,
          permissionDenied: true,
          permissionType: permissionError.permissionType,
        });
      }
      return this.failEntry(entry, {
        success: false,
        error: errorMessage(error),
      });
    }
  }

  async executeBrowserAction(
    rawParams: BrowserActionParams,
  ): Promise<BrowserActionResult> {
    const params = this.normalizeBrowserActionParams(rawParams);
    const entry = this.createEntry(
      `browser_${params.action}`,
      this.toParamsRecord(params),
    );

    try {
      const approvalError = await this.awaitApproval(
        this.browserApprovalCommand(params.action),
        this.toParamsRecord(params),
      );
      if (approvalError) {
        return this.failEntry(entry, { success: false, error: approvalError });
      }

      switch (params.action) {
        case "open":
        case "connect": {
          const state = await openBrowser(params.url);
          return this.succeedEntry(entry, {
            success: true,
            url: state.url,
            title: state.title,
            isOpen: true,
            is_open: true,
            data: state,
            content: stringifyData(state),
            message: `Opened browser: ${state.url}`,
          });
        }
        case "close":
          await closeBrowser();
          return this.succeedEntry(entry, {
            success: true,
            isOpen: false,
            is_open: false,
            message: "Browser closed.",
          });
        case "navigate": {
          const url = this.requireIdentifier(
            params.url,
            "url is required for navigate",
          );
          const state = await navigateBrowser(url);
          return this.succeedEntry(entry, {
            success: true,
            url: state.url,
            title: state.title,
            isOpen: true,
            is_open: true,
            data: state,
            content: stringifyData(state),
            message: `Navigated to ${state.url}`,
          });
        }
        case "click":
          await clickBrowser(params.selector, params.coordinate, params.text);
          return this.succeedEntry(entry, {
            success: true,
            message: "Clicked browser target.",
          });
        case "type":
          if (!params.text) {
            throw new Error("text is required for browser type");
          }
          await typeBrowser(params.text, params.selector);
          return this.succeedEntry(entry, {
            success: true,
            message: "Typed browser text.",
          });
        case "scroll":
          await scrollBrowser(params.direction ?? "down", params.amount ?? 300);
          return this.succeedEntry(entry, {
            success: true,
            message: `Scrolled browser ${params.direction ?? "down"}.`,
          });
        case "screenshot": {
          const screenshot = await screenshotBrowser();
          return this.succeedEntry(entry, {
            success: true,
            screenshot,
            frontendScreenshot: screenshot,
            message: "Captured browser screenshot.",
          });
        }
        case "dom":
        case "get_dom": {
          const content = await getBrowserDom();
          return this.succeedEntry(entry, {
            success: true,
            content,
            message: "Fetched browser DOM.",
          });
        }
        case "clickables":
        case "get_clickables": {
          const elements = await getBrowserClickables();
          return this.succeedEntry(entry, {
            success: true,
            elements,
            count: elements.length,
            data: elements,
            content: stringifyData(elements),
            message: "Fetched browser clickables.",
          });
        }
        case "execute": {
          const code = this.requireIdentifier(
            params.code,
            "code is required for browser execute",
          );
          const content = await executeBrowser(code);
          return this.succeedEntry(entry, {
            success: true,
            content,
            message: "Executed browser JavaScript.",
          });
        }
        case "state": {
          const data = await getBrowserState();
          return this.succeedEntry(entry, {
            success: true,
            url: data.url,
            title: data.title,
            isOpen: true,
            is_open: true,
            data,
            content: stringifyData(data),
          });
        }
        case "info": {
          const info = await getBrowserInfo();
          const result: BrowserActionResult = {
            success: info.success,
            url: info.url,
            title: info.title,
            isOpen: info.isOpen,
            is_open: info.is_open,
            data: info,
            content: stringifyData(info),
            ...(info.success ? {} : { error: info.error }),
          };
          return info.success
            ? this.succeedEntry(entry, result)
            : this.failEntry(entry, result);
        }
        case "context": {
          const data = await getBrowserContext();
          return this.succeedEntry(entry, {
            success: true,
            url: data.url,
            title: data.title,
            isOpen: true,
            is_open: true,
            data,
            content: stringifyData(data),
          });
        }
        case "wait":
          await waitBrowser(
            params.selector,
            params.text,
            params.timeout ?? this.cuConfig.actionTimeoutMs,
          );
          return this.succeedEntry(entry, {
            success: true,
            message: "Browser wait condition satisfied.",
          });
        case "list_tabs": {
          const tabs = await listBrowserTabs();
          return this.succeedEntry(entry, {
            success: true,
            tabs,
            count: tabs.length,
            data: tabs,
            content: stringifyData(tabs),
          });
        }
        case "open_tab": {
          const tab = await openBrowserTab(params.url);
          return this.succeedEntry(entry, {
            success: true,
            data: tab,
            content: stringifyData(tab),
            message: `Opened tab ${tab.id}.`,
          });
        }
        case "close_tab": {
          const tabId = this.requireIdentifier(
            params.tabId,
            "tabId is required for close_tab",
          );
          await closeBrowserTab(tabId);
          return this.succeedEntry(entry, {
            success: true,
            message: `Closed tab ${tabId}.`,
          });
        }
        case "switch_tab": {
          const tabId = this.requireIdentifier(
            params.tabId,
            "tabId is required for switch_tab",
          );
          const state = await switchBrowserTab(tabId);
          return this.succeedEntry(entry, {
            success: true,
            url: state.url,
            title: state.title,
            isOpen: true,
            is_open: true,
            data: state,
            content: stringifyData(state),
            message: `Switched to tab ${tabId}.`,
          });
        }
        default:
          return this.failEntry(entry, {
            success: false,
            error: `Unknown browser action: ${(params as { action: string }).action}`,
          });
      }
    } catch (error) {
      return this.failEntry(entry, {
        success: false,
        error: errorMessage(error),
      });
    }
  }

  async executeWindowAction(
    rawParams: WindowActionParams,
  ): Promise<WindowActionResult> {
    const params = this.normalizeWindowActionParams(rawParams);
    const entry = this.createEntry(
      `window_${params.action}`,
      this.toParamsRecord(params),
    );

    try {
      const approvalError = await this.awaitApproval(
        this.windowApprovalCommand(params.action),
        this.toParamsRecord(params),
      );
      if (approvalError) {
        return this.failEntry(entry, { success: false, error: approvalError });
      }

      switch (params.action) {
        case "list": {
          const windows = listWindows();
          return this.succeedEntry(entry, {
            success: true,
            windows,
            count: windows.length,
          });
        }
        case "focus":
          focusWindow(this.requireWindowTarget(params));
          return this.succeedEntry(entry, {
            success: true,
            message: "Focused window.",
          });
        case "switch":
          switchWindow(this.requireWindowTarget(params));
          return this.succeedEntry(entry, {
            success: true,
            message: "Switched window.",
          });
        case "arrange":
          return this.succeedEntry(entry, arrangeWindows(params.arrangement));
        case "move": {
          const result = moveWindow(
            this.requireWindowTarget(params),
            this.requireNumber(params.x, "x is required for window move"),
            this.requireNumber(params.y, "y is required for window move"),
          );
          return this.succeedEntry(entry, result);
        }
        case "minimize":
          minimizeWindow(this.requireWindowTarget(params));
          return this.succeedEntry(entry, {
            success: true,
            message: "Window minimized.",
          });
        case "maximize":
          maximizeWindow(this.requireWindowTarget(params));
          return this.succeedEntry(entry, {
            success: true,
            message: "Window maximized.",
          });
        case "restore":
          restoreWindow(this.requireWindowTarget(params));
          return this.succeedEntry(entry, {
            success: true,
            message: "Window restored.",
          });
        case "close":
          closeWindow(this.requireWindowTarget(params));
          return this.succeedEntry(entry, {
            success: true,
            message: "Window closed.",
          });
        default:
          return this.failEntry(entry, {
            success: false,
            error: `Unknown window action: ${(params as { action: string }).action}`,
          });
      }
    } catch (error) {
      const permissionError = classifyPermissionDeniedError(error, {
        permissionType: "accessibility",
        operation: params.action,
      });
      if (permissionError) {
        return this.failEntry(entry, {
          success: false,
          error: permissionError.message,
          permissionDenied: true,
          permissionType: permissionError.permissionType,
        });
      }
      return this.failEntry(entry, {
        success: false,
        error: errorMessage(error),
      });
    }
  }

  async executeFileAction(
    rawParams: FileActionParams,
  ): Promise<FileActionResult> {
    const params = this.normalizeFileActionParams(rawParams);
    const entry = this.createEntry(
      `file_${params.action}`,
      this.toParamsRecord(params),
    );

    try {
      const approvalError = await this.awaitApproval(
        this.fileApprovalCommand(params.action),
        this.toParamsRecord(params),
      );
      if (approvalError) {
        return this.failEntry(entry, { success: false, error: approvalError });
      }

      const targetPath =
        params.action === "list_downloads"
          ? this.defaultDownloadsPath()
          : this.requireIdentifier(
              params.path,
              "path is required for file action",
            );

      switch (params.action) {
        case "read":
        case "download":
          return this.finishFileEntry(
            entry,
            await readFile(targetPath, this.normalizeEncoding(params.encoding)),
          );
        case "write":
        case "upload":
          if (typeof params.content !== "string") {
            throw new Error("content is required for file write");
          }
          return this.finishFileEntry(
            entry,
            await writeFile(targetPath, params.content),
          );
        case "edit":
          if (typeof params.old_text !== "string") {
            throw new Error("old_text is required for file edit");
          }
          if (typeof params.new_text !== "string") {
            throw new Error("new_text is required for file edit");
          }
          return this.finishFileEntry(
            entry,
            await editFile(targetPath, params.old_text, params.new_text),
          );
        case "append":
          if (typeof params.content !== "string") {
            throw new Error("content is required for file append");
          }
          return this.finishFileEntry(
            entry,
            await appendFile(targetPath, params.content),
          );
        case "delete":
          return this.finishFileEntry(entry, await deleteFile(targetPath));
        case "exists":
          return this.finishFileEntry(entry, await fileExists(targetPath));
        case "list":
        case "list_downloads":
          return this.finishFileEntry(entry, await listDirectory(targetPath));
        case "delete_directory":
          return this.finishFileEntry(entry, await deleteDirectory(targetPath));
        default:
          return this.failEntry(entry, {
            success: false,
            error: `Unknown file action: ${(params as { action: string }).action}`,
          });
      }
    } catch (error) {
      return this.failEntry(entry, {
        success: false,
        error: errorMessage(error),
      });
    }
  }

  async executeTerminalAction(
    rawParams: TerminalActionParams,
  ): Promise<TerminalActionResult> {
    const params = this.normalizeTerminalActionParams(rawParams);
    const entry = this.createEntry(
      `terminal_${params.action}`,
      this.toParamsRecord(params),
    );

    try {
      const approvalError = await this.awaitApproval(
        this.terminalApprovalCommand(params.action),
        this.toParamsRecord(params),
      );
      if (approvalError) {
        return this.failEntry(entry, { success: false, error: approvalError });
      }

      switch (params.action) {
        case "connect":
          return this.finishTerminalEntry(
            entry,
            await connectTerminal(params.cwd),
          );
        case "execute":
          return this.finishTerminalEntry(
            entry,
            await executeTerminal({
              command: this.requireIdentifier(
                params.command,
                "command is required for terminal execute",
              ),
              timeoutSeconds:
                params.timeout ??
                Math.max(1, Math.ceil(this.cuConfig.actionTimeoutMs / 1000)),
              sessionId: params.sessionId,
              cwd: params.cwd,
            }),
          );
        case "read":
          return this.finishTerminalEntry(
            entry,
            await readTerminal(params.sessionId),
          );
        case "type":
          return this.finishTerminalEntry(
            entry,
            await typeTerminal(
              this.requireIdentifier(
                params.text,
                "text is required for terminal type",
              ),
            ),
          );
        case "clear":
          return this.finishTerminalEntry(
            entry,
            await clearTerminal(params.sessionId),
          );
        case "close":
          return this.finishTerminalEntry(
            entry,
            await closeTerminal(params.sessionId),
          );
        case "execute_command":
          return this.finishTerminalEntry(
            entry,
            await executeTerminal({
              command: this.requireIdentifier(
                params.command,
                "command is required for execute_command",
              ),
              timeoutSeconds:
                params.timeout ??
                Math.max(1, Math.ceil(this.cuConfig.actionTimeoutMs / 1000)),
              sessionId: params.sessionId,
              cwd: params.cwd,
            }),
          );
        default:
          return this.failEntry(entry, {
            success: false,
            error: `Unknown terminal action: ${(params as { action: string }).action}`,
          });
      }
    } catch (error) {
      return this.failEntry(entry, {
        success: false,
        error: errorMessage(error),
      });
    }
  }

  async captureScreen(): Promise<Buffer> {
    return driverCaptureScreenshot();
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

  subscribeApprovals(
    listener: (snapshot: ApprovalSnapshot) => void,
  ): () => void {
    return this.approvalManager.subscribe(listener);
  }

  resolveApproval(
    id: string,
    approved: boolean,
    reason?: string,
  ): ApprovalResolution | null {
    return this.approvalManager.resolveApproval(id, approved, reason);
  }

  private normalizeDesktopActionParams(
    params: DesktopActionParams,
  ): DesktopActionParams {
    const coordinate =
      params.coordinate ??
      (params.x !== undefined && params.y !== undefined
        ? [Number(params.x), Number(params.y)]
        : undefined);
    const startCoordinate =
      params.startCoordinate ??
      (params.x1 !== undefined && params.y1 !== undefined
        ? [Number(params.x1), Number(params.y1)]
        : undefined);
    const endCoordinate =
      coordinate ??
      (params.x2 !== undefined && params.y2 !== undefined
        ? [Number(params.x2), Number(params.y2)]
        : undefined);

    return {
      ...params,
      coordinate: endCoordinate,
      startCoordinate,
      modifiers: params.modifiers ?? params.hold_keys,
      scrollAmount: params.scrollAmount ?? params.amount,
    };
  }

  private normalizeBrowserActionParams(
    params: BrowserActionParams,
  ): BrowserActionParams {
    const tabIdCandidate = params.tabId ?? params.index ?? params.tab_index;
    return {
      ...params,
      tabId: tabIdCandidate !== undefined ? String(tabIdCandidate) : undefined,
      action: this.normalizeBrowserAction(params.action),
    };
  }

  private normalizeWindowActionParams(
    params: WindowActionParams,
  ): WindowActionParams {
    return {
      ...params,
      windowId: params.windowId ?? params.window ?? params.title,
      windowTitle: params.windowTitle ?? params.window ?? params.title,
    };
  }

  private normalizeFileActionParams(
    params: FileActionParams,
  ): FileActionParams {
    return {
      ...params,
      path: params.path ?? params.filepath ?? params.dirpath,
      old_text: params.old_text ?? params.oldText ?? params.find,
      new_text: params.new_text ?? params.newText ?? params.replace,
    };
  }

  private normalizeTerminalActionParams(
    params: TerminalActionParams,
  ): TerminalActionParams {
    return {
      ...params,
      timeout: params.timeout ?? params.timeoutSeconds,
      sessionId: params.sessionId ?? params.session_id,
      action:
        params.action === "execute_command" ? "execute_command" : params.action,
    };
  }

  private normalizeBrowserAction(
    action: BrowserActionParams["action"],
  ): BrowserActionParams["action"] {
    switch (action) {
      case "get_dom":
        return "dom";
      case "get_clickables":
        return "clickables";
      default:
        return action;
    }
  }

  private desktopApprovalCommand(
    action: DesktopActionParams["action"],
  ): string {
    return action === "key" ? "key_press" : action;
  }

  private browserApprovalCommand(
    action: BrowserActionParams["action"],
  ): string {
    switch (action) {
      case "open":
        return "browser_open";
      case "connect":
        return "browser_connect";
      case "close":
        return "browser_close";
      case "navigate":
        return "browser_navigate";
      case "click":
        return "browser_click";
      case "type":
        return "browser_type";
      case "scroll":
        return "browser_scroll";
      case "screenshot":
        return "browser_screenshot";
      case "dom":
        return "browser_get_dom";
      case "clickables":
        return "browser_get_clickables";
      case "execute":
        return "browser_execute";
      case "state":
        return "browser_state";
      case "info":
        return "browser_info";
      case "context":
        return "browser_get_context";
      case "wait":
        return "browser_wait";
      case "list_tabs":
        return "browser_list_tabs";
      case "open_tab":
        return "browser_open_tab";
      case "close_tab":
        return "browser_close_tab";
      case "switch_tab":
        return "browser_switch_tab";
      case "get_dom":
        return "browser_get_dom";
      case "get_clickables":
        return "browser_get_clickables";
      default:
        return `browser_${action as string}`;
    }
  }

  private windowApprovalCommand(action: WindowActionParams["action"]): string {
    switch (action) {
      case "list":
        return "list_windows";
      case "focus":
      case "switch":
        return "switch_to_window";
      case "arrange":
        return "arrange_windows";
      case "move":
        return "move_window";
      case "minimize":
        return "minimize_window";
      case "maximize":
        return "maximize_window";
      case "restore":
        return "restore_window";
      case "close":
        return "close_window";
    }
  }

  private fileApprovalCommand(action: FileActionParams["action"]): string {
    switch (action) {
      case "read":
        return "file_read";
      case "write":
        return "file_write";
      case "edit":
        return "file_edit";
      case "append":
        return "file_append";
      case "delete":
        return "file_delete";
      case "exists":
        return "file_exists";
      case "list":
        return "directory_list";
      case "delete_directory":
        return "directory_delete";
      case "upload":
        return "file_upload";
      case "download":
        return "file_download";
      case "list_downloads":
        return "file_list_downloads";
      case "list_directory":
        return "directory_list";
      default:
        return `file_${action as string}`;
    }
  }

  private terminalApprovalCommand(
    action: TerminalActionParams["action"],
  ): string {
    switch (action) {
      case "connect":
        return "terminal_connect";
      case "execute":
        return "terminal_execute";
      case "read":
        return "terminal_read";
      case "type":
        return "terminal_type";
      case "clear":
        return "terminal_clear";
      case "close":
        return "terminal_close";
      case "execute_command":
        return "execute_command";
    }
  }

  private mapDesktopCommandToAction(
    command: string,
  ): DesktopActionParams["action"] {
    switch (command) {
      case "key_press":
        return "key";
      default:
        return command as DesktopActionParams["action"];
    }
  }

  private mapBrowserCommandToAction(
    command: string,
  ): BrowserActionParams["action"] {
    const value = command.replace(/^browser_/, "");
    switch (value) {
      case "get_dom":
        return "get_dom";
      case "get_clickables":
        return "get_clickables";
      case "get_context":
        return "context";
      default:
        return value as BrowserActionParams["action"];
    }
  }

  private mapWindowCommandToAction(
    command: string,
  ): WindowActionParams["action"] {
    switch (command) {
      case "list_windows":
        return "list";
      case "switch_to_window":
        return "switch";
      case "arrange_windows":
        return "arrange";
      case "move_window":
        return "move";
      case "minimize_window":
        return "minimize";
      case "maximize_window":
        return "maximize";
      case "restore_window":
        return "restore";
      case "close_window":
        return "close";
      default:
        return "list";
    }
  }

  private mapFileCommandToAction(command: string): FileActionParams["action"] {
    switch (command) {
      case "file_read":
        return "read";
      case "file_write":
        return "write";
      case "file_edit":
        return "edit";
      case "file_append":
        return "append";
      case "file_delete":
        return "delete";
      case "file_exists":
        return "exists";
      case "directory_list":
        return "list";
      case "directory_delete":
        return "delete_directory";
      case "file_upload":
        return "upload";
      case "file_download":
        return "download";
      case "file_list_downloads":
        return "list_downloads";
      default:
        return "read";
    }
  }

  private mapTerminalCommandToAction(
    command: string,
  ): TerminalActionParams["action"] {
    switch (command) {
      case "terminal_connect":
        return "connect";
      case "terminal_execute":
        return "execute";
      case "terminal_read":
        return "read";
      case "terminal_type":
        return "type";
      case "terminal_clear":
        return "clear";
      case "terminal_close":
        return "close";
      case "execute_command":
        return "execute_command";
      default:
        return "connect";
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

  private async captureScreenshotBase64(): Promise<string> {
    const buf = await driverCaptureScreenshot();
    return buf.toString("base64");
  }

  private shouldCaptureAfterDesktopAction(
    action: DesktopActionParams["action"],
  ): boolean {
    return action !== "screenshot" &&
      action !== "detect_elements" &&
      action !== "ocr"
      ? this.cuConfig.screenshotAfterAction
      : false;
  }

  private createEntry(
    action: string,
    params: Record<string, unknown>,
  ): ActionHistoryEntry {
    return {
      action,
      timestamp: Date.now(),
      params,
      success: false,
    };
  }

  private succeedEntry<T extends { success: boolean }>(
    entry: ActionHistoryEntry,
    result: T,
  ): T {
    entry.success = true;
    this.pushAction(entry);
    return result;
  }

  private failEntry<T extends { success: boolean }>(
    entry: ActionHistoryEntry,
    result: T,
  ): T {
    entry.success = false;
    this.pushAction(entry);
    return result;
  }

  private finishFileEntry(
    entry: ActionHistoryEntry,
    result: FileActionResult,
  ): FileActionResult {
    const normalized: FileActionResult = {
      ...result,
      isFile: result.isFile ?? result.is_file,
      isDirectory: result.isDirectory ?? result.is_directory,
      is_file: result.is_file ?? result.isFile,
      is_directory: result.is_directory ?? result.isDirectory,
    };
    return normalized.success
      ? this.succeedEntry(entry, normalized)
      : this.failEntry(entry, normalized);
  }

  private finishTerminalEntry(
    entry: ActionHistoryEntry,
    result: TerminalActionResult,
  ): TerminalActionResult {
    const normalized: TerminalActionResult = {
      ...result,
      exitCode: result.exitCode ?? result.exit_code,
      exit_code: result.exit_code ?? result.exitCode,
      sessionId: result.sessionId ?? result.session_id,
      session_id: result.session_id ?? result.sessionId,
    };
    return normalized.success
      ? this.succeedEntry(entry, normalized)
      : this.failEntry(entry, normalized);
  }

  private requireCoordinate(
    coordinate: [number, number] | undefined,
    action: string,
    fieldName: string = "coordinate",
  ): asserts coordinate is [number, number] {
    if (!coordinate || coordinate.length < 2) {
      throw new Error(`${fieldName} [x, y] is required for ${action}`);
    }
  }

  private requireIdentifier(
    value: string | undefined,
    message: string,
  ): string {
    if (!value) {
      throw new Error(message);
    }
    return value;
  }

  private requireNumber(value: number | undefined, message: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(message);
    }
    return value;
  }

  private requireWindowTarget(params: WindowActionParams): string {
    return (
      params.windowId ??
      params.windowTitle ??
      this.requireIdentifier(undefined, "windowId or windowTitle is required")
    );
  }

  private normalizeEncoding(
    value: string | BufferEncoding | undefined,
  ): BufferEncoding {
    switch (String(value ?? "utf8").toLowerCase()) {
      case "ascii":
        return "ascii";
      case "base64":
        return "base64";
      case "hex":
        return "hex";
      case "latin1":
      case "binary":
        return "latin1";
      case "ucs2":
      case "ucs-2":
      case "utf16le":
      case "utf-16le":
        return "utf16le";
      default:
        return "utf8";
    }
  }

  private defaultDownloadsPath(): string {
    return path.join(os.homedir(), "Downloads");
  }

  private toParamsRecord(value: object): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(value).filter(
        ([, entryValue]) => entryValue !== undefined,
      ),
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
        const value = runtime.getSetting(key);
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          return String(value);
        }
      } catch {
        // ignore runtime setting lookup failures
      }
      return undefined;
    };

    const screenshotAfter = getSetting("COMPUTER_USE_SCREENSHOT_AFTER_ACTION");
    if (screenshotAfter !== undefined) {
      this.cuConfig.screenshotAfterAction =
        screenshotAfter !== "false" && screenshotAfter !== "0";
    }

    const timeout = getSetting("COMPUTER_USE_ACTION_TIMEOUT_MS");
    if (timeout) {
      const numericTimeout = Number.parseInt(timeout, 10);
      if (Number.isFinite(numericTimeout) && numericTimeout > 0) {
        this.cuConfig.actionTimeoutMs = numericTimeout;
      }
    }

    const approvalMode = getSetting("COMPUTER_USE_APPROVAL_MODE");
    if (approvalMode && isApprovalMode(approvalMode)) {
      this.cuConfig.approvalMode = approvalMode;
      this.approvalManager.setMode(approvalMode);
    }

    const browserHeadless = getSetting("COMPUTER_USE_BROWSER_HEADLESS");
    if (browserHeadless !== undefined) {
      this.cuConfig.browserHeadless =
        browserHeadless === "true" || browserHeadless === "1";
    }
    setBrowserRuntimeOptions({
      headless: this.cuConfig.browserHeadless ?? false,
    });
  }

  private detectCapabilities(): PlatformCapabilities {
    return detectPlatformCapabilities({
      osName: currentPlatform(),
      commandExists,
      isBrowserAvailable,
      shell: process.env.SHELL,
    });
  }
}
