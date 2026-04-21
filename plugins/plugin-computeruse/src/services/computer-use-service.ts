/**
 * ComputerUseService — long-lived service managing desktop automation,
 * browser control, screenshots, files, terminal access, and window control.
 */

import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import { ApprovalManager } from "../approval/approval-manager.js";
import { normalizeComputerUseParams } from "../normalization.js";
import {
  browserWait,
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
  switchBrowserTab,
  typeBrowser,
} from "../platform/browser.js";
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
  fileDownload,
  fileExists,
  fileListDownloads,
  fileUpload,
  listDirectory,
  readFile,
  writeFile,
} from "../platform/files.js";
import { commandExists, currentPlatform } from "../platform/helpers.js";
import { permissionDeniedResultFromError } from "../platform/permissions.js";
import { captureScreenshot } from "../platform/screenshot.js";
import {
  clearTerminal,
  closeTerminal,
  connectTerminal,
  executeCommand,
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
  BrowserActionParams,
  BrowserActionResult,
  BrowserTab,
  ComputerActionResult,
  ComputerUseConfig,
  ComputerUseResult,
  DesktopActionParams,
  FileActionParams,
  FileActionResult,
  FileEntry,
  PermissionType,
  PlatformCapabilities,
  ScreenSize,
  TerminalActionParams,
  TerminalActionResult,
  WindowActionParams,
  WindowActionResult,
  WindowInfo,
} from "../types.js";

const MAX_RECENT_ACTIONS = 10;

type ApprovalSnapshot = {
  mode: string;
  pendingCount: number;
  pendingApprovals: Array<{
    id: string;
    command: string;
    parameters: Record<string, unknown>;
    requestedAt: string;
  }>;
};

export class ComputerUseService extends Service {
  static serviceType = "computeruse";

  capabilityDescription =
    "Desktop automation — screenshots, mouse/keyboard control, browser CDP, terminal, files, and window management";

  private capabilities!: PlatformCapabilities;
  private recentActions: ActionHistoryEntry[] = [];
  private screenSize: ScreenSize = { width: 1920, height: 1080 };
  private readonly approvalManager = new ApprovalManager({ mode: "full_control" });
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
      `[computeruse] Service started — platform=${currentPlatform()} screen=${instance.screenSize.width}x${instance.screenSize.height} approval=${instance.approvalManager.getMode()}`,
    );

    if (!instance.capabilities.screenshot.available) {
      logger.warn(`[computeruse] Screenshot not available: ${instance.capabilities.screenshot.tool}`);
    }
    if (!instance.capabilities.computerUse.available) {
      logger.warn(`[computeruse] Mouse/keyboard not available: ${instance.capabilities.computerUse.tool}`);
    }

    return instance;
  }

  async stop(): Promise<void> {
    this.approvalManager.cancelAllPendingApprovals("service stopped");
    try {
      await closeBrowser();
    } catch {
      /* ignore */
    }
    logger.info("[computeruse] Service stopped");
  }

  async executeDesktopAction(rawParams: DesktopActionParams): Promise<ComputerActionResult> {
    const params = this.normalizeDesktopParams(rawParams);
    const entry: ActionHistoryEntry = {
      action: params.action,
      timestamp: Date.now(),
      params: this.toRecord(params),
      success: false,
    };

    if (params.action === "detect_elements" || params.action === "ocr") {
      return this.completeFailure(entry, {
        success: false,
        error: `${params.action} is not available on local machines. Use screenshots plus model analysis instead.`,
      });
    }

    const approval = await this.awaitApproval(this.desktopCommandName(params.action), this.toRecord(params));
    if (approval) {
      return this.completeFailure(entry, approval);
    }

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
          break;
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
        case "click_with_modifiers":
          this.requireCoordinate(params);
          desktopClickWithModifiers(params.coordinate![0], params.coordinate![1], params.modifiers ?? []);
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
          if (!params.startCoordinate) {
            throw new Error("startCoordinate is required for drag action");
          }
          this.requireCoordinate(params);
          desktopDrag(
            params.startCoordinate[0],
            params.startCoordinate[1],
            params.coordinate![0],
            params.coordinate![1],
          );
          break;
      }

      let screenshot: string | undefined;
      if (params.action === "screenshot" || this.cuConfig.screenshotAfterAction) {
        try {
          screenshot = captureScreenshot().toString("base64");
        } catch (err) {
          if (params.action === "screenshot") {
            return this.completeFailure(entry, this.resultFromError(err));
          }
          logger.warn(`[computeruse] Screenshot capture failed after action: ${String(err)}`);
        }
      }

      entry.success = true;
      this.pushAction(entry);
      return {
        success: true,
        screenshot,
        message:
          params.action === "screenshot"
            ? "Screenshot captured."
            : `Desktop action ${params.action} completed.`,
      };
    } catch (err) {
      return this.completeFailure(entry, this.resultFromError(err));
    }
  }

  async executeBrowserAction(rawParams: BrowserActionParams): Promise<BrowserActionResult> {
    const params = this.normalizeBrowserParams(rawParams);
    const entry: ActionHistoryEntry = {
      action: `browser_${params.action}`,
      timestamp: Date.now(),
      params: this.toRecord(params),
      success: false,
    };

    const approval = await this.awaitApproval(
      this.browserCommandName(params.action),
      this.toRecord(params),
    );
    if (approval) {
      return this.completeFailure(entry, approval);
    }

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
          result = {
            success: true,
            content: `Opened browser: ${state.url} — ${state.title}`,
            data: state,
          };
          break;
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
          if (!params.url) throw new Error("url is required for navigate action");
          const state = await navigateBrowser(params.url);
          result = {
            success: true,
            content: `Navigated to: ${state.url} — ${state.title}`,
            data: state,
          };
          break;
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
          result = { success: true, content: `Scrolled ${params.direction ?? "down"}.` };
          break;
        case "screenshot":
          result = { success: true, screenshot: await screenshotBrowser() };
          break;
        case "dom":
        case "get_dom": {
          const html = await getBrowserDom();
          result = { success: true, content: html };
          break;
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
        case "execute":
          if (!params.code) throw new Error("code is required for execute action");
          result = { success: true, content: await executeBrowser(params.code) };
          break;
        case "state": {
          const state = await getBrowserState();
          result = {
            success: true,
            content: `URL: ${state.url}\nTitle: ${state.title}`,
            data: state,
          };
          break;
        }
        case "info": {
          const info = await getBrowserInfo();
          result = info.success
            ? { success: true, content: JSON.stringify(info, null, 2), data: info }
            : { success: false, error: info.error ?? "Browser is not open." };
          break;
        }
        case "context":
        case "get_context": {
          const state = await getBrowserContext();
          result = {
            success: true,
            content: `URL: ${state.url}\nTitle: ${state.title}`,
            data: state,
          };
          break;
        }
        case "wait": {
          const waitResult = await browserWait(
            params.selector,
            params.waitForText ?? params.text,
            params.timeout ?? 5000,
          );
          result = waitResult.success
            ? { success: true, content: waitResult.message ?? "Wait completed." }
            : { success: false, error: waitResult.error ?? "Browser wait failed." };
          break;
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
          result = { success: true, data: tab, content: `Opened tab: ${tab.url}` };
          break;
        }
        case "close_tab": {
          const tabId = params.tabId ?? this.indexToTabId(params.index);
          if (!tabId) throw new Error("tabId or index is required for close_tab");
          await closeBrowserTab(tabId);
          result = { success: true, content: `Closed tab ${tabId}.` };
          break;
        }
        case "switch_tab": {
          const tabId = params.tabId ?? this.indexToTabId(params.index);
          if (!tabId) throw new Error("tabId or index is required for switch_tab");
          const state = await switchBrowserTab(tabId);
          result = { success: true, content: `Switched to tab: ${state.url}`, data: state };
          break;
        }
      }

      entry.success = result.success;
      this.pushAction(entry);
      return result;
    } catch (err) {
      return this.completeFailure(entry, this.resultFromError(err));
    }
  }

  async executeWindowAction(rawParams: WindowActionParams): Promise<WindowActionResult> {
    const params = this.normalizeWindowParams(rawParams);
    const entry: ActionHistoryEntry = {
      action: `window_${params.action}`,
      timestamp: Date.now(),
      params: this.toRecord(params),
      success: false,
    };

    const approval = await this.awaitApproval(
      this.windowCommandName(params.action),
      this.toRecord(params),
    );
    if (approval) {
      return this.completeFailure(entry, approval);
    }

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
          return { success: true, windows, message: `${windows.length} visible windows.` };
        }
        case "focus": {
          const target = this.requireWindowTarget(params, "focus");
          focusWindow(target);
          break;
        }
        case "switch": {
          const target = this.requireWindowTarget(params, "switch");
          switchWindow(target);
          break;
        }
        case "arrange": {
          entry.success = true;
          this.pushAction(entry);
          return arrangeWindows(params.arrangement);
        }
        case "move": {
          entry.success = true;
          this.pushAction(entry);
          return moveWindow(params.x, params.y);
        }
        case "minimize": {
          const target = this.requireWindowTarget(params, "minimize");
          minimizeWindow(target);
          break;
        }
        case "maximize": {
          const target = this.requireWindowTarget(params, "maximize");
          maximizeWindow(target);
          break;
        }
        case "restore": {
          const target = this.requireWindowTarget(params, "restore");
          restoreWindow(target);
          break;
        }
        case "close": {
          const target = this.requireWindowTarget(params, "close");
          closeWindow(target);
          break;
        }
        default:
          throw new Error(`Unknown window action: ${params.action}`);
      }

      entry.success = true;
      this.pushAction(entry);
      return { success: true, message: `Window ${params.action} completed.` };
    } catch (err) {
      return this.completeFailure(entry, this.resultFromError(err));
    }
  }

  async executeFileAction(rawParams: FileActionParams): Promise<FileActionResult> {
    const { action, command, params } = this.normalizeFileAction(rawParams);
    const entry: ActionHistoryEntry = {
      action: command,
      timestamp: Date.now(),
      params: { ...params },
      success: false,
    };

    const approval = await this.awaitApproval(command, params);
    if (approval) {
      return this.completeFailure(entry, approval);
    }

    try {
      let output: unknown;
      switch (action) {
        case "read":
          output = await readFile({ path: String(params.path ?? ""), encoding: String(params.encoding ?? "utf-8") });
          break;
        case "write":
          output = await writeFile({ path: String(params.path ?? ""), content: String(params.content ?? "") });
          break;
        case "edit":
          output = await editFile({
            path: String(params.path ?? ""),
            old_text: String(params.old_text ?? params.oldText ?? ""),
            new_text: String(params.new_text ?? params.newText ?? ""),
          });
          break;
        case "append":
          output = await appendFile({ path: String(params.path ?? ""), content: String(params.content ?? "") });
          break;
        case "delete":
          output = await deleteFile({ path: String(params.path ?? "") });
          break;
        case "exists":
          output = await fileExists({ path: String(params.path ?? "") });
          break;
        case "list_directory":
          output = await listDirectory({ path: String(params.path ?? "") });
          break;
        case "delete_directory":
          output = await deleteDirectory({ path: String(params.path ?? "") });
          break;
        case "upload":
          output = await fileUpload({ path: String(params.path ?? ""), content: String(params.content ?? "") });
          break;
        case "download":
          output = await fileDownload({
            path: String(params.path ?? ""),
            encoding: String(params.encoding ?? "utf-8"),
          });
          break;
        case "list_downloads":
          output = await fileListDownloads({ path: String(params.path ?? "") });
          break;
        default:
          throw new Error(`Unknown file action: ${action}`);
      }

      const result = this.mapFileActionResult(output);
      entry.success = result.success;
      this.pushAction(entry);
      return result;
    } catch (err) {
      return this.completeFailure(entry, this.resultFromError(err));
    }
  }

  async executeTerminalAction(rawParams: TerminalActionParams): Promise<TerminalActionResult> {
    const { action, command, params } = this.normalizeTerminalAction(rawParams);
    const entry: ActionHistoryEntry = {
      action: command,
      timestamp: Date.now(),
      params: { ...params },
      success: false,
    };

    const approval = await this.awaitApproval(command, params);
    if (approval) {
      return this.completeFailure(entry, approval);
    }

    try {
      let output: unknown;
      switch (action) {
        case "connect":
          output = connectTerminal({ cwd: this.asString(params.cwd) });
          break;
        case "execute":
          output = await executeTerminal({
            command: this.asString(params.command) ?? "",
            timeout: this.asNumber(params.timeout),
            session_id: this.resolveSessionId(params),
          });
          break;
        case "read":
          output = readTerminal({ session_id: this.resolveSessionId(params) });
          break;
        case "type":
          output = typeTerminal({
            text: this.asString(params.text) ?? "",
            session_id: this.resolveSessionId(params),
          });
          break;
        case "clear":
          output = clearTerminal({ session_id: this.resolveSessionId(params) });
          break;
        case "close":
          output = closeTerminal({ session_id: this.resolveSessionId(params) });
          break;
        case "execute_command":
          output = await executeCommand({
            command: this.asString(params.command) ?? "",
            timeout: this.asNumber(params.timeout),
            session_id: this.resolveSessionId(params),
          });
          break;
        default:
          throw new Error(`Unknown terminal action: ${action}`);
      }

      const result = this.mapTerminalActionResult(output);
      entry.success = result.success;
      this.pushAction(entry);
      return result;
    } catch (err) {
      return this.completeFailure(entry, this.resultFromError(err));
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

  getApprovalSnapshot(): ApprovalSnapshot {
    const pendingApprovals = this.approvalManager.listPendingApprovals().map((approval) => ({
      id: approval.id,
      command: approval.command,
      parameters: { ...approval.parameters },
      requestedAt: approval.requestedAt.toISOString(),
    }));

    return {
      mode: this.approvalManager.getMode(),
      pendingCount: pendingApprovals.length,
      pendingApprovals,
    };
  }

  resolveApproval(
    id: string,
    approved: boolean,
    reason?: string,
  ): {
    id: string;
    command: string;
    approved: boolean;
    cancelled: boolean;
    mode: string;
    requestedAt: string;
    resolvedAt: string;
    reason?: string;
  } | null {
    const resolution = this.approvalManager.resolvePendingApproval(id, approved, reason);
    if (!resolution) {
      return null;
    }

    return {
      id: resolution.id,
      command: resolution.command,
      approved: resolution.approved,
      cancelled: resolution.cancelled,
      mode: resolution.mode,
      requestedAt: resolution.requestedAt.toISOString(),
      resolvedAt: resolution.resolvedAt.toISOString(),
      reason: resolution.reason,
    };
  }

  private normalizeDesktopParams(rawParams: DesktopActionParams): DesktopActionParams {
    const normalized = normalizeComputerUseParams(
      String(rawParams.action ?? "screenshot"),
      rawParams as unknown as Record<string, unknown>,
    );

    return {
      action: String(normalized.action ?? rawParams.action ?? "screenshot") as DesktopActionParams["action"],
      coordinate: this.asPoint(normalized.coordinate),
      startCoordinate: this.asPoint(normalized.startCoordinate),
      modifiers: this.asStringArray(normalized.modifiers),
      text: this.asString(normalized.text),
      key: this.asString(normalized.key),
      scrollDirection: this.asScrollDirection(normalized.scrollDirection),
      scrollAmount: this.asNumber(normalized.scrollAmount),
    };
  }

  private normalizeBrowserParams(rawParams: BrowserActionParams): BrowserActionParams {
    const rawAction = String(rawParams.action ?? "state");
    const command = rawAction.startsWith("browser_") ? rawAction : `browser_${rawAction}`;
    const normalized = normalizeComputerUseParams(
      command,
      rawParams as unknown as Record<string, unknown>,
    );

    return {
      action: this.canonicalBrowserAction(String(normalized.action ?? rawAction)),
      url: this.asString(normalized.url),
      selector: this.asString(normalized.selector),
      coordinate: this.asPoint(normalized.coordinate),
      text: this.asString(normalized.text),
      code: this.asString(normalized.code),
      waitForText: this.asString(normalized.waitForText),
      waitForTextGone: this.asString(normalized.waitForTextGone),
      direction: this.asBrowserDirection(normalized.direction),
      amount: this.asNumber(normalized.amount),
      tabId: this.asString(normalized.tabId),
      index: this.asNumber(normalized.index),
      timeout: this.asNumber(normalized.timeout),
    };
  }

  private normalizeWindowParams(rawParams: WindowActionParams): WindowActionParams {
    const rawAction = String(rawParams.action ?? "list");
    const command = this.windowCommandName(this.canonicalWindowAction(rawAction));
    const normalized = normalizeComputerUseParams(
      command,
      rawParams as unknown as Record<string, unknown>,
    );

    return {
      action: this.canonicalWindowAction(String(normalized.action ?? rawAction)),
      windowId: this.asString(normalized.windowId),
      windowTitle: this.asString(normalized.windowTitle),
      appName: this.asString(normalized.appName),
      title: this.asString(normalized.title),
      window: this.asString(normalized.window),
      arrangement: this.asString(normalized.arrangement),
      x: this.asNumber(normalized.x),
      y: this.asNumber(normalized.y),
    };
  }

  private normalizeFileAction(rawParams: FileActionParams): {
    action: string;
    command: string;
    params: Record<string, unknown>;
  } {
    const rawAction = String(rawParams.action ?? "read");
    const mapping: Record<string, { action: string; command: string }> = {
      read: { action: "read", command: "file_read" },
      file_read: { action: "read", command: "file_read" },
      write: { action: "write", command: "file_write" },
      file_write: { action: "write", command: "file_write" },
      edit: { action: "edit", command: "file_edit" },
      file_edit: { action: "edit", command: "file_edit" },
      append: { action: "append", command: "file_append" },
      file_append: { action: "append", command: "file_append" },
      delete: { action: "delete", command: "file_delete" },
      file_delete: { action: "delete", command: "file_delete" },
      exists: { action: "exists", command: "file_exists" },
      file_exists: { action: "exists", command: "file_exists" },
      list_directory: { action: "list_directory", command: "directory_list" },
      directory_list: { action: "list_directory", command: "directory_list" },
      delete_directory: { action: "delete_directory", command: "directory_delete" },
      directory_delete: { action: "delete_directory", command: "directory_delete" },
      upload: { action: "upload", command: "file_upload" },
      file_upload: { action: "upload", command: "file_upload" },
      download: { action: "download", command: "file_download" },
      file_download: { action: "download", command: "file_download" },
      list_downloads: { action: "list_downloads", command: "file_list_downloads" },
      file_list_downloads: { action: "list_downloads", command: "file_list_downloads" },
    };
    const resolved = mapping[rawAction] ?? mapping.read;
    const normalized = normalizeComputerUseParams(
      resolved.command,
      rawParams as unknown as Record<string, unknown>,
    );
    normalized.action = resolved.action;

    return { action: resolved.action, command: resolved.command, params: normalized };
  }

  private normalizeTerminalAction(rawParams: TerminalActionParams): {
    action: string;
    command: string;
    params: Record<string, unknown>;
  } {
    const rawAction = String(rawParams.action ?? "terminal_execute");
    const mapping: Record<string, { action: string; command: string }> = {
      connect: { action: "connect", command: "terminal_connect" },
      terminal_connect: { action: "connect", command: "terminal_connect" },
      execute: { action: "execute", command: "terminal_execute" },
      terminal_execute: { action: "execute", command: "terminal_execute" },
      read: { action: "read", command: "terminal_read" },
      terminal_read: { action: "read", command: "terminal_read" },
      type: { action: "type", command: "terminal_type" },
      terminal_type: { action: "type", command: "terminal_type" },
      clear: { action: "clear", command: "terminal_clear" },
      terminal_clear: { action: "clear", command: "terminal_clear" },
      close: { action: "close", command: "terminal_close" },
      terminal_close: { action: "close", command: "terminal_close" },
      execute_command: { action: "execute_command", command: "execute_command" },
    };
    const resolved = mapping[rawAction] ?? mapping.terminal_execute;
    const normalized = normalizeComputerUseParams(
      resolved.command,
      rawParams as unknown as Record<string, unknown>,
    );
    normalized.action = resolved.action;

    return { action: resolved.action, command: resolved.command, params: normalized };
  }

  private canonicalBrowserAction(action: string): BrowserActionParams["action"] {
    switch (action) {
      case "browser_open":
      case "browser_connect":
        return "open";
      case "browser_navigate":
        return "navigate";
      case "browser_click":
        return "click";
      case "browser_type":
        return "type";
      case "browser_scroll":
        return "scroll";
      case "browser_screenshot":
        return "screenshot";
      case "browser_dom":
        return "dom";
      case "browser_get_dom":
        return "get_dom";
      case "browser_get_clickables":
        return "get_clickables";
      case "browser_state":
        return "state";
      case "browser_info":
        return "info";
      case "browser_get_context":
        return "get_context";
      case "browser_wait":
        return "wait";
      case "browser_list_tabs":
        return "list_tabs";
      case "browser_open_tab":
        return "open_tab";
      case "browser_close_tab":
        return "close_tab";
      case "browser_switch_tab":
        return "switch_tab";
      default:
        return action as BrowserActionParams["action"];
    }
  }

  private canonicalWindowAction(action: string): WindowActionParams["action"] {
    switch (action) {
      case "switch_to_window":
        return "switch";
      case "focus_window":
        return "focus";
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
        return action as WindowActionParams["action"];
    }
  }

  private desktopCommandName(action: DesktopActionParams["action"]): string {
    switch (action) {
      case "key":
        return "key_press";
      default:
        return action;
    }
  }

  private browserCommandName(action: BrowserActionParams["action"]): string {
    switch (action) {
      case "open":
      case "connect":
        return "browser_open";
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
        return "browser_dom";
      case "get_dom":
        return "browser_get_dom";
      case "clickables":
      case "get_clickables":
        return "browser_get_clickables";
      case "execute":
        return "browser_execute";
      case "state":
        return "browser_state";
      case "info":
        return "browser_info";
      case "context":
      case "get_context":
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
      default:
        return `browser_${action}`;
    }
  }

  private windowCommandName(action: WindowActionParams["action"]): string {
    switch (action) {
      case "list":
        return "list_windows";
      case "focus":
        return "focus_window";
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
      default:
        return action;
    }
  }

  private async awaitApproval(
    command: string,
    params: Record<string, unknown>,
  ): Promise<ComputerUseResult | null> {
    if (this.approvalManager.shouldAutoApprove(command)) {
      return null;
    }

    if (this.approvalManager.isDenyAll()) {
      return {
        success: false,
        error: `Command ${command} denied because computer-use approval mode is off.`,
        message: "Computer use approvals are disabled in off mode.",
      };
    }

    const resolution = await this.approvalManager.requestApproval(command, params);
    if (resolution.approved) {
      return null;
    }

    return {
      success: false,
      error: resolution.reason ?? `Approval denied for ${command}.`,
      message: resolution.cancelled
        ? `Approval for ${command} was cancelled.`
        : `Approval denied for ${command}.`,
    };
  }

  private completeFailure<TResult extends ComputerUseResult>(
    entry: ActionHistoryEntry,
    result: TResult,
  ): TResult {
    entry.success = false;
    this.pushAction(entry);
    return result;
  }

  private resultFromError(err: unknown): ComputerUseResult {
    const permission = permissionDeniedResultFromError(err);
    if (permission) {
      return {
        success: false,
        error: permission.error,
        permissionDenied: true,
        permissionType: this.mapPermissionType(permission.permissionType),
        message: permission.details ?? permission.error,
      };
    }

    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  private mapPermissionType(permissionType: string): PermissionType {
    return permissionType === "screen_recording" ? "screen-recording" : "accessibility";
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

  private requireWindowTarget(params: WindowActionParams, action: string): string {
    const target =
      params.windowId ??
      params.windowTitle ??
      params.title ??
      params.window ??
      params.appName;
    if (!target) {
      throw new Error(`windowId, windowTitle, title, window, or appName is required for ${action}`);
    }
    return target;
  }

  private resolveSessionId(params: Record<string, unknown>): string | undefined {
    return this.asString(params.session_id) ?? this.asString(params.sessionId);
  }

  private indexToTabId(index: number | undefined): string | undefined {
    return Number.isFinite(index) ? String(index) : undefined;
  }

  private asString(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    return value as Record<string, unknown>;
  }

  private asNumber(value: unknown): number | undefined {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return undefined;
  }

  private asPoint(value: unknown): [number, number] | undefined {
    if (!Array.isArray(value) || value.length < 2) {
      return undefined;
    }

    const x = this.asNumber(value[0]);
    const y = this.asNumber(value[1]);
    if (x === undefined || y === undefined) {
      return undefined;
    }

    return [x, y];
  }

  private asStringArray(value: unknown): string[] | undefined {
    if (!Array.isArray(value)) {
      return undefined;
    }

    const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
    return items.length > 0 ? items : undefined;
  }

  private asScrollDirection(value: unknown): DesktopActionParams["scrollDirection"] {
    return value === "up" || value === "down" || value === "left" || value === "right"
      ? value
      : undefined;
  }

  private asBrowserDirection(value: unknown): BrowserActionParams["direction"] {
    return value === "up" || value === "down" ? value : undefined;
  }

  private toRecord<T extends object>(value: T): Record<string, unknown> {
    return { ...value } as Record<string, unknown>;
  }

  private mapFileActionResult(output: unknown): FileActionResult {
    const data = this.asRecord(output);
    return {
      success: data.success === true,
      message: this.asString(data.message),
      error: this.asString(data.error),
      path: this.asString(data.path),
      content: this.asString(data.content),
      exists: data.exists === true,
      isFile: data.is_file === true || data.isFile === true,
      isDirectory: data.is_directory === true || data.isDirectory === true,
      size: this.asNumber(data.size),
      count: this.asNumber(data.count),
      items: Array.isArray(data.items) ? (data.items as FileEntry[]) : undefined,
    };
  }

  private mapTerminalActionResult(output: unknown): TerminalActionResult {
    const data = this.asRecord(output);
    return {
      success: data.success === true,
      message: this.asString(data.message),
      error: this.asString(data.error),
      sessionId: this.asString(data.session_id) ?? this.asString(data.sessionId),
      cwd: this.asString(data.cwd),
      output: this.asString(data.output),
      exitCode: this.asNumber(data.exit_code) ?? this.asNumber(data.exitCode),
    };
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
    if (
      approvalMode === "full_control" ||
      approvalMode === "smart_approve" ||
      approvalMode === "approve_all" ||
      approvalMode === "off"
    ) {
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
      terminal: { available: true, tool: os === "win32" ? "PowerShell" : "/bin/bash" },
      fileSystem: { available: true, tool: "Node.js fs" },
    };

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

    if (os === "darwin") {
      caps.computerUse = commandExists("cliclick")
        ? { available: true, tool: "cliclick" }
        : { available: true, tool: "AppleScript/Swift (limited)" };
    } else if (os === "linux") {
      caps.computerUse = commandExists("xdotool")
        ? { available: true, tool: "xdotool" }
        : { available: false, tool: "none (install xdotool)" };

    if (os === "darwin") {
      caps.windowList = { available: true, tool: "AppleScript System Events" };
    } else if (os === "linux") {
      if (commandExists("wmctrl")) caps.windowList = { available: true, tool: "wmctrl" };
      else if (commandExists("xdotool")) caps.windowList = { available: true, tool: "xdotool" };
      else caps.windowList = { available: false, tool: "none (install wmctrl or xdotool)" };
    } else if (os === "win32") {
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
