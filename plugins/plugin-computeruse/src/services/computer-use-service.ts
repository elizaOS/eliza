import os from "node:os";
import path from "node:path";
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
import {
  ComputerUseApprovalManager,
  isApprovalMode,
} from "../approval-manager.js";
import {
  desktopClick,
  desktopClickWithModifiers,
  desktopDoubleClick,
  desktopDrag,
  desktopKeyCombo,
  desktopKeyPress,
  desktopMouseMove,
  desktopRightClick,
  desktopScroll,
  desktopType,
} from "../platform/desktop.js";
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
import { classifyPermissionDeniedError } from "../platform/permissions.js";
import { captureScreenshot } from "../platform/screenshot.js";
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
  closeWindow,
  focusWindow,
  getScreenSize,
  listWindows,
  maximizeWindow,
  minimizeWindow,
  restoreWindow,
  switchWindow,
} from "../platform/windows-list.js";
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
import { commandExists, currentPlatform } from "../platform/helpers.js";

const MAX_RECENT_ACTIONS = 10;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringifyData(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
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
      `[computeruse] Service started — platform=${currentPlatform()} screen=${instance.screenSize.width}x${instance.screenSize.height} approval=${instance.getApprovalMode()}`,
    );

    return instance;
  }

  async stop(): Promise<void> {
    this.approvalManager.cancelAll("computer-use service stopped");
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
          ...(parameters as unknown as DesktopActionParams),
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
          ...(parameters as unknown as BrowserActionParams),
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
          ...(parameters as unknown as WindowActionParams),
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
          ...(parameters as unknown as FileActionParams),
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
          ...(parameters as unknown as TerminalActionParams),
          action: this.mapTerminalCommandToAction(command),
        });
      default:
        return {
          success: false,
          error: `Unknown computer-use command: ${command}`,
        };
    }
  }

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
          return this.succeedEntry(entry, {
            success: true,
            screenshot: this.captureScreenshotBase64(),
          });
        case "click":
          this.requireCoordinate(params.coordinate, "click");
          desktopClick(params.coordinate[0], params.coordinate[1]);
          break;
        case "click_with_modifiers":
          this.requireCoordinate(params.coordinate, "click_with_modifiers");
          desktopClickWithModifiers(
            params.coordinate[0],
            params.coordinate[1],
            params.modifiers ?? [],
            params.button ?? "left",
            params.clicks ?? 1,
          );
          break;
        case "double_click":
          this.requireCoordinate(params.coordinate, "double_click");
          desktopDoubleClick(params.coordinate[0], params.coordinate[1]);
          break;
        case "right_click":
          this.requireCoordinate(params.coordinate, "right_click");
          desktopRightClick(params.coordinate[0], params.coordinate[1]);
          break;
        case "mouse_move":
          this.requireCoordinate(params.coordinate, "mouse_move");
          desktopMouseMove(params.coordinate[0], params.coordinate[1]);
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
          if (!params.key) {
            throw new Error("key is required for key_combo action");
          }
          desktopKeyCombo(params.key);
          break;
        case "scroll":
          this.requireCoordinate(params.coordinate, "scroll");
          desktopScroll(
            params.coordinate[0],
            params.coordinate[1],
            params.scrollDirection ?? "down",
            params.scrollAmount ?? 3,
          );
          break;
        case "drag":
          this.requireCoordinate(params.startCoordinate, "drag");
          this.requireCoordinate(params.coordinate, "drag");
          desktopDrag(
            params.startCoordinate[0],
            params.startCoordinate[1],
            params.coordinate[0],
            params.coordinate[1],
          );
          break;
      }

      const result: ComputerActionResult = { success: true };
      if (this.shouldCaptureAfterDesktopAction(params.action)) {
        try {
          result.screenshot = this.captureScreenshotBase64();
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
      }
    } catch (error) {
      return this.failEntry(entry, {
        success: false,
        error: errorMessage(error),
      });
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
          return this.succeedEntry(entry, {
            success: true,
            message:
              "Window arrangement is a parity no-op on the local runtime unless handled by the platform window manager.",
          });
        case "move":
          return this.succeedEntry(entry, {
            success: true,
            message:
              "Window move is a parity no-op on the local runtime unless handled by the platform window manager.",
          });
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
          : this.requireIdentifier(params.path, "path is required for file action");

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
          return this.finishFileEntry(
            entry,
            await deleteDirectory(targetPath),
          );
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
              this.requireIdentifier(params.text, "text is required for terminal type"),
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
      }
    } catch (error) {
      return this.failEntry(entry, {
        success: false,
        error: errorMessage(error),
      });
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

  private normalizeFileActionParams(params: FileActionParams): FileActionParams {
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
  }

  private detectCapabilities(): PlatformCapabilities {
    const osName = currentPlatform();
    const caps: PlatformCapabilities = {
      screenshot: { available: false, tool: "none" },
      computerUse: { available: false, tool: "none" },
      windowList: { available: false, tool: "none" },
      browser: { available: false, tool: "none" },
      terminal: { available: false, tool: "none" },
      fileSystem: { available: true, tool: "node:fs" },
    };

    if (osName === "darwin") {
      caps.screenshot = { available: true, tool: "screencapture (built-in)" };
      caps.computerUse = commandExists("cliclick")
        ? { available: true, tool: "cliclick" }
        : {
            available: true,
            tool: "AppleScript / Swift fallbacks (mouse_move requires cliclick)",
          };
      caps.windowList = {
        available: true,
        tool: "AppleScript System Events",
      };
    } else if (osName === "linux") {
      if (commandExists("import")) {
        caps.screenshot = { available: true, tool: "ImageMagick import" };
      } else if (commandExists("scrot")) {
        caps.screenshot = { available: true, tool: "scrot" };
      } else if (commandExists("gnome-screenshot")) {
        caps.screenshot = { available: true, tool: "gnome-screenshot" };
      } else {
        caps.screenshot = {
          available: false,
          tool: "none (install ImageMagick, scrot, or gnome-screenshot)",
        };
      }

      caps.computerUse = commandExists("xdotool")
        ? { available: true, tool: "xdotool" }
        : { available: false, tool: "none (install xdotool)" };

      if (commandExists("wmctrl")) {
        caps.windowList = { available: true, tool: "wmctrl" };
      } else if (commandExists("xdotool")) {
        caps.windowList = { available: true, tool: "xdotool" };
      } else {
        caps.windowList = {
          available: false,
          tool: "none (install wmctrl or xdotool)",
        };
      }
    } else if (osName === "win32") {
      caps.screenshot = { available: true, tool: "PowerShell System.Drawing" };
      caps.computerUse = { available: true, tool: "PowerShell user32.dll" };
      caps.windowList = { available: true, tool: "PowerShell Get-Process" };
    }

    caps.browser = isBrowserAvailable()
      ? { available: true, tool: "puppeteer-core (Chromium detected)" }
      : { available: false, tool: "none (no Chrome/Edge/Brave found)" };

    caps.terminal =
      osName === "win32"
        ? { available: true, tool: "powershell.exe" }
        : commandExists(process.env.SHELL ?? "/bin/bash")
          ? { available: true, tool: process.env.SHELL ?? "/bin/bash" }
          : { available: true, tool: process.env.SHELL ?? "/bin/sh" };

    return caps;
  }
}
