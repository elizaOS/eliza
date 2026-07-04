/**
 * ComputerUseService (serviceType "computeruse") — the plugin's central service.
 * Owns input dispatch, screenshot capture, the browser CDP session, window
 * operations, approval-manager wiring, and the SceneBuilder lifecycle, exposing
 * them to the actions and providers.
 *
 * This is the single seam between the agent-facing action surface and the platform
 * drivers: it resolves the active driver, enforces the approval gate before
 * executing input, and caches per-turn scene state.
 */
import os from "node:os";
import path from "node:path";
import { type IAgentRuntime, logger, Service } from "@elizaos/core";
import {
  ComputerUseApprovalManager,
  isApprovalMode,
} from "../approval-manager.js";
import {
  getCoordOcrProvider,
  getSetOfMarksProvider,
} from "../mobile/ocr-provider.js";
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
import { captureDisplay, capturePrimaryDisplay } from "../platform/capture.js";
import { localToGlobalDefault } from "../platform/coords.js";
import {
  getPrimaryDisplay,
  listDisplays,
  warmDisplaysCache,
} from "../platform/displays.js";
import {
  driverCaptureScreenshot,
  driverClick,
  driverClickWithModifiers,
  driverDoubleClick,
  driverDrag,
  driverDragPath,
  driverGetCursorPosition,
  driverKeyCombo,
  driverKeyDown,
  driverKeyPress,
  driverKeyUp,
  driverMiddleClick,
  driverMouseDown,
  driverMouseMove,
  driverMouseUp,
  driverRightClick,
  driverScroll,
  driverSetValue,
  driverType,
} from "../platform/driver.js";
import {
  appendFile,
  createDirectory,
  deleteDirectory,
  deleteFile,
  directoryExists,
  editFile,
  fileExists,
  getFileSize,
  listDirectory,
  readBytes,
  readFile,
  writeBytes,
  writeFile,
} from "../platform/file-ops.js";
import { commandExists, currentPlatform } from "../platform/helpers.js";
import { killApp, launchApp, openTarget } from "../platform/launch.js";
import { classifyPermissionDeniedError } from "../platform/permissions.js";
import { disposePsHost, warmPsHost } from "../platform/ps-host.js";
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
  getActiveWindow,
  getApplicationWindows,
  getScreenSize,
  getWindowBounds,
  maximizeWindow,
  minimizeWindow,
  moveWindow,
  refreshWindows,
  resizeWindow,
  restoreWindow,
  switchWindow,
  warmScreenSizeCache,
  warmWindowsCache,
} from "../platform/windows-list.js";
import { SceneBuilder, type SceneUpdateEvent } from "../scene/scene-builder.js";
import type { Scene, SceneVlmElement } from "../scene/scene-types.js";
import {
  type ScreenState,
  type ScreenStateChange,
  ScreenStateStore,
} from "../scene/screen-state.js";
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
  DisplayDescriptor,
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
const COORDINATE_BEARING_ACTIONS = new Set<DesktopActionParams["action"]>([
  "click",
  "click_with_modifiers",
  "double_click",
  "right_click",
  "mouse_move",
  "middle_click",
  "mouse_down",
  "mouse_up",
  "scroll",
  "drag",
  "set_value",
]);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isBrowserNotOpenMessage(message: unknown): boolean {
  const text =
    typeof message === "string"
      ? message
      : message instanceof Error
        ? message.message
        : "";
  return text.includes(BROWSER_NOT_OPEN_ERROR);
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
  private displayIdDeprecationWarned = false;
  private sceneBuilder: SceneBuilder = new SceneBuilder({
    log: (msg) => logger.warn(msg),
  });
  /**
   * Single shared per-display capture for the turn (#9105 M3). OCR, the Brain,
   * and the DirtyTileDescriber all read through this store so the screen is
   * grabbed once per tick instead of once per consumer.
   */
  private screenStateStore: ScreenStateStore = new ScreenStateStore({
    capture: (displayId) => captureDisplay(displayId),
  });
  private cuConfig: ComputerUseConfig = {
    screenshotAfterAction: true,
    actionTimeoutMs: 10000,
    maxRecentActions: MAX_RECENT_ACTIONS,
    approvalMode: "smart_approve",
    browserHeadless: false,
    mode: "yolo",
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

    // Windows: pre-warm the persistent PowerShell host (and seed the display
    // cache through it) so the first capture/clipboard/scene turn doesn't pay
    // the ~10-16s cold `powershell.exe` spawn tax. Fire-and-forget — never
    // blocks startup, and every consumer falls back to one-shot spawns if the
    // host fails to warm. No-op off Windows.
    if (currentPlatform() === "win32") {
      void warmPsHost()
        .then(() =>
          Promise.all([
            warmDisplaysCache(),
            warmWindowsCache(),
            warmScreenSizeCache(),
          ]),
        )
        .catch(() => {});
    }

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
    // Tear down the persistent PowerShell host and latch spawning off so a
    // late fire-and-forget warm continuation can't resurrect it post-stop.
    disposePsHost();
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
      case "middle_click":
      case "mouse_down":
      case "mouse_up":
      case "type":
      case "key_press":
      case "key_combo":
      case "key_down":
      case "key_up":
      case "scroll":
      case "drag":
      case "get_cursor_position":
      case "detect_elements":
      case "ocr":
      case "open":
      case "launch":
      case "kill_app":
      case "set_value":
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
      case "file_read_bytes":
      case "file_write_bytes":
      case "file_create_dir":
      case "file_directory_exists":
      case "file_get_file_size":
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

      if (params.action === "ocr" || params.action === "detect_elements") {
        return this.runOcrOrDetect(entry, params);
      }

      const targetDisplayId = this.resolveDisplayIdForAction(params);
      switch (params.action) {
        case "screenshot": {
          const captured = await this.captureScreenshotForDisplay(
            params.displayId ?? targetDisplayId,
          );
          return this.succeedEntry(entry, {
            success: true,
            screenshot: captured.base64,
            displayId: captured.displayId,
          });
        }
        case "click": {
          this.requireCoordinate(params.coordinate, "click");
          const g = this.toGlobal(params, params.coordinate);
          await driverClick(g.x, g.y);
          break;
        }
        case "click_with_modifiers": {
          this.requireCoordinate(params.coordinate, "click_with_modifiers");
          const g = this.toGlobal(params, params.coordinate);
          await driverClickWithModifiers(g.x, g.y, params.modifiers ?? []);
          break;
        }
        case "double_click": {
          this.requireCoordinate(params.coordinate, "double_click");
          const g = this.toGlobal(params, params.coordinate);
          await driverDoubleClick(g.x, g.y);
          break;
        }
        case "right_click": {
          this.requireCoordinate(params.coordinate, "right_click");
          const g = this.toGlobal(params, params.coordinate);
          await driverRightClick(g.x, g.y);
          break;
        }
        case "mouse_move": {
          this.requireCoordinate(params.coordinate, "mouse_move");
          const g = this.toGlobal(params, params.coordinate);
          await driverMouseMove(g.x, g.y);
          break;
        }
        case "middle_click": {
          this.requireCoordinate(params.coordinate, "middle_click");
          const g = this.toGlobal(params, params.coordinate);
          await driverMiddleClick(g.x, g.y);
          break;
        }
        case "mouse_down": {
          this.requireCoordinate(params.coordinate, "mouse_down");
          const g = this.toGlobal(params, params.coordinate);
          await driverMouseDown(g.x, g.y, params.button ?? "left");
          break;
        }
        case "mouse_up": {
          this.requireCoordinate(params.coordinate, "mouse_up");
          const g = this.toGlobal(params, params.coordinate);
          await driverMouseUp(g.x, g.y, params.button ?? "left");
          break;
        }
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
        case "key_down":
          if (!params.key) {
            throw new Error("key is required for key_down action");
          }
          await driverKeyDown(params.key);
          break;
        case "key_up":
          if (!params.key) {
            throw new Error("key is required for key_up action");
          }
          await driverKeyUp(params.key);
          break;
        case "scroll": {
          this.requireCoordinate(params.coordinate, "scroll");
          const g = this.toGlobal(params, params.coordinate);
          await driverScroll(
            g.x,
            g.y,
            params.scrollDirection ?? "down",
            params.scrollAmount ?? 3,
          );
          break;
        }
        case "get_cursor_position": {
          // Read-only query — no coordinate, no post-action screenshot.
          const pos = await driverGetCursorPosition();
          return this.succeedEntry(entry, {
            success: true,
            cursorPosition: pos,
            message: `Cursor is at (${pos.x}, ${pos.y}).`,
          });
        }
        case "drag": {
          // A `path` of ≥2 points traces a real polyline (curves, corners,
          // marquee, swipe paths); otherwise fall back to a straight
          // startCoordinate→coordinate drag.
          if (params.path && params.path.length >= 2) {
            const global = params.path.map((p) => this.toGlobal(params, p));
            await driverDragPath(global);
            break;
          }
          this.requireCoordinate(
            params.startCoordinate,
            "drag",
            "startCoordinate",
          );
          this.requireCoordinate(params.coordinate, "drag");
          const start = this.toGlobal(params, params.startCoordinate);
          const end = this.toGlobal(params, params.coordinate);
          await driverDrag(start.x, start.y, end.x, end.y);
          break;
        }
        case "open": {
          if (!params.target) {
            throw new Error("target is required for open action");
          }
          await openTarget(params.target);
          return this.succeedEntry(entry, {
            success: true,
            message: `Opened ${params.target}.`,
          });
        }
        case "launch": {
          if (!params.app) {
            throw new Error("app is required for launch action");
          }
          const launched = await launchApp(params.app, params.appArgs ?? []);
          return this.succeedEntry(entry, {
            success: true,
            data: { pid: launched.pid, command: launched.command },
            message: `Launched ${params.app} (pid ${launched.pid}).`,
          });
        }
        case "kill_app": {
          // Accepts a pid or an app/process name via `target` (pairs with launch).
          const target = params.target ?? params.app;
          if (!target) {
            throw new Error(
              "target (pid or app name) is required for kill_app action",
            );
          }
          const killed = await killApp(String(target));
          return this.succeedEntry(entry, {
            success: true,
            data: killed,
            message: `Terminated ${killed.target}.`,
          });
        }
        case "set_value": {
          this.requireCoordinate(params.coordinate, "set_value");
          if (typeof params.text !== "string") {
            throw new Error(
              "text (the value) is required for set_value action",
            );
          }
          const g = this.toGlobal(params, params.coordinate);
          await driverSetValue(g.x, g.y, params.text);
          break;
        }
        default:
          return this.failEntry(entry, {
            success: false,
            error: `Unknown desktop action: ${(params as { action: string }).action}`,
          });
      }

      const result: ComputerActionResult = { success: true };
      if (this.shouldCaptureAfterDesktopAction(params.action)) {
        try {
          const captured = await this.captureScreenshotForDisplay(
            params.displayId ?? targetDisplayId,
          );
          result.screenshot = captured.base64;
          result.displayId = captured.displayId;
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

  /**
   * `ocr` / `detect_elements` — real on-device OCR via the registered
   * CoordOcrProvider (plugin-vision contributes native Windows.Media.Ocr / Apple
   * Vision / docTR through `registerCoordOcrProvider`). Replaces the former
   * "not available on local machines" stub. Read-only; coordinates are
   * display-local so the agent can click them directly.
   */
  private async runOcrOrDetect(
    entry: ActionHistoryEntry,
    params: DesktopActionParams,
  ): Promise<ComputerActionResult> {
    const displayId =
      params.displayId ?? this.resolveDisplayIdForAction(params);

    // detect_elements prefers Set-of-Marks grounding when a provider is
    // registered (GGUF YOLO icons + OCR text fused into 1-indexed numbered
    // marks + overlay, #9170 M9). Falls back to OCR-only text elements.
    if (params.action === "detect_elements") {
      const somResult = await this.runSetOfMarksDetect(entry, displayId);
      if (somResult) return somResult;
    }

    const provider = getCoordOcrProvider();
    if (!provider) {
      return this.failEntry(entry, {
        success: false,
        error:
          "No OCR provider is registered. Enable @elizaos/plugin-vision for on-device OCR (Windows.Media.Ocr / Apple Vision / docTR).",
      });
    }
    try {
      const cap = await captureDisplay(displayId);
      const { blocks } = await provider.describe({
        displayId: String(cap.display.id),
        sourceX: 0,
        sourceY: 0,
        pngBytes: new Uint8Array(cap.frame),
      });
      if (params.action === "detect_elements") {
        const elements = blocks.map((b, i) => ({
          id: `e${i + 1}`,
          kind: "text" as const,
          text: b.text,
          bbox: [b.bbox.x, b.bbox.y, b.bbox.width, b.bbox.height] as [
            number,
            number,
            number,
            number,
          ],
          semantic_position: b.semantic_position,
          displayId: cap.display.id,
        }));
        return this.succeedEntry(entry, {
          success: true,
          displayId: cap.display.id,
          data: { elements, count: elements.length },
          message: `Detected ${elements.length} text element(s) on display ${cap.display.id}.`,
        });
      }
      const text = blocks.map((b) => b.text).join("\n");
      return this.succeedEntry(entry, {
        success: true,
        displayId: cap.display.id,
        data: { text, blocks },
        message: `OCR found ${blocks.length} text block(s) on display ${cap.display.id}.`,
      });
    } catch (error) {
      return this.failEntry(entry, {
        success: false,
        error: errorMessage(error),
      });
    }
  }

  /**
   * Set-of-Marks `detect_elements` path (#9170 M9). Returns `null` when no SoM
   * provider is registered so the caller falls back to OCR-only detection.
   * Each numbered mark becomes an element whose `center` is the click target
   * the VLM's chosen number resolves to; the numbered-overlay PNG is returned
   * for the prompt under `data.setOfMarks.overlay`.
   */
  private async runSetOfMarksDetect(
    entry: ActionHistoryEntry,
    displayId: number,
  ): Promise<ComputerActionResult | null> {
    const som = getSetOfMarksProvider();
    if (!som) return null;
    try {
      const cap = await captureDisplay(displayId);
      const { marks, overlayPngBase64 } = await som.describe({
        displayId: String(cap.display.id),
        sourceX: 0,
        sourceY: 0,
        pngBytes: new Uint8Array(cap.frame),
        renderOverlay: true,
      });
      const elements = marks.map((m) => ({
        id: `m${m.index}`,
        mark: m.index,
        kind: m.source,
        text: m.label ?? "",
        bbox: [m.bbox[0], m.bbox[1], m.bbox[2], m.bbox[3]] as [
          number,
          number,
          number,
          number,
        ],
        center: [m.center[0], m.center[1]] as [number, number],
        score: m.score,
        displayId: cap.display.id,
      }));
      return this.succeedEntry(entry, {
        success: true,
        displayId: cap.display.id,
        data: {
          elements,
          count: elements.length,
          setOfMarks: {
            marks,
            ...(overlayPngBase64 ? { overlay: overlayPngBase64 } : {}),
          },
        },
        message: `Set-of-Marks detected ${elements.length} numbered element(s) on display ${cap.display.id}.`,
      });
    } catch (error) {
      // SoM is best-effort; surface a clear failure rather than silently
      // dropping to OCR (the caller already chose SoM by registering it).
      return this.failEntry(entry, {
        success: false,
        error: `Set-of-Marks detection failed: ${errorMessage(error)}`,
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

      const result = await this.runBrowserAction(params);
      if (this.shouldAutoOpenBrowser(params.action, result.error)) {
        return await this.retryBrowserActionAfterOpen(entry, params);
      }
      return result.success
        ? this.succeedEntry(entry, result)
        : this.failEntry(entry, result);
    } catch (error) {
      if (this.shouldAutoOpenBrowser(params.action, error)) {
        return await this.retryBrowserActionAfterOpen(entry, params);
      }
      return this.failEntry(entry, {
        success: false,
        error: errorMessage(error),
      });
    }
  }

  private async retryBrowserActionAfterOpen(
    entry: ActionHistoryEntry,
    params: BrowserActionParams,
  ): Promise<BrowserActionResult> {
    try {
      const openResult = await this.runBrowserAction({
        ...params,
        action: "open",
      });
      if (!openResult.success) {
        return this.failEntry(entry, openResult);
      }

      const retryResult = await this.runBrowserAction(params);
      return retryResult.success
        ? this.succeedEntry(entry, retryResult)
        : this.failEntry(entry, retryResult);
    } catch (error) {
      return this.failEntry(entry, {
        success: false,
        error: errorMessage(error),
      });
    }
  }

  private shouldAutoOpenBrowser(
    action: BrowserActionParams["action"],
    error: unknown,
  ): boolean {
    return (
      !BROWSER_LIFECYCLE_ACTIONS.has(action) && isBrowserNotOpenMessage(error)
    );
  }

  private async runBrowserAction(
    params: BrowserActionParams,
  ): Promise<BrowserActionResult> {
    switch (params.action) {
      case "open":
      case "connect": {
        const state = await openBrowser(params.url);
        return {
          success: true,
          url: state.url,
          title: state.title,
          isOpen: true,
          is_open: true,
          data: state,
          content: stringifyData(state),
          message: `Opened browser: ${state.url}`,
        };
      }
      case "close":
        await closeBrowser();
        return {
          success: true,
          isOpen: false,
          is_open: false,
          message: "Browser closed.",
        };
      case "navigate": {
        const url = this.requireIdentifier(
          params.url,
          "url is required for navigate",
        );
        const state = await navigateBrowser(url);
        return {
          success: true,
          url: state.url,
          title: state.title,
          isOpen: true,
          is_open: true,
          data: state,
          content: stringifyData(state),
          message: `Navigated to ${state.url}`,
        };
      }
      case "click":
        await clickBrowser(params.selector, params.coordinate, params.text);
        return {
          success: true,
          message: "Clicked browser target.",
        };
      case "type":
        if (!params.text) {
          throw new Error("text is required for browser type");
        }
        await typeBrowser(params.text, params.selector);
        return {
          success: true,
          message: "Typed browser text.",
        };
      case "scroll":
        await scrollBrowser(params.direction ?? "down", params.amount ?? 300);
        return {
          success: true,
          message: `Scrolled browser ${params.direction ?? "down"}.`,
        };
      case "screenshot": {
        const screenshot = await screenshotBrowser();
        return {
          success: true,
          screenshot,
          frontendScreenshot: screenshot,
          message: "Captured browser screenshot.",
        };
      }
      case "dom":
      case "get_dom": {
        const content = await getBrowserDom();
        return {
          success: true,
          content,
          message: "Fetched browser DOM.",
        };
      }
      case "clickables":
      case "get_clickables": {
        const elements = await getBrowserClickables();
        return {
          success: true,
          elements,
          count: elements.length,
          data: elements,
          content: stringifyData(elements),
          message: "Fetched browser clickables.",
        };
      }
      case "execute": {
        const code = this.requireIdentifier(
          params.code,
          "code is required for browser execute",
        );
        const content = await executeBrowser(code);
        return {
          success: true,
          content,
          message: "Executed browser JavaScript.",
        };
      }
      case "state": {
        const data = await getBrowserState();
        return {
          success: true,
          url: data.url,
          title: data.title,
          isOpen: true,
          is_open: true,
          data,
          content: stringifyData(data),
        };
      }
      case "info": {
        const info = await getBrowserInfo();
        return {
          success: info.success,
          url: info.url,
          title: info.title,
          isOpen: info.isOpen,
          is_open: info.is_open,
          data: info,
          content: stringifyData(info),
          ...(info.success ? {} : { error: info.error }),
        };
      }
      case "context":
      case "get_context": {
        const data = await getBrowserContext();
        return {
          success: true,
          url: data.url,
          title: data.title,
          isOpen: true,
          is_open: true,
          data,
          content: stringifyData(data),
        };
      }
      case "wait":
        await waitBrowser(
          params.selector,
          params.text,
          params.timeout ?? this.cuConfig.actionTimeoutMs,
        );
        return {
          success: true,
          message: "Browser wait condition satisfied.",
        };
      case "list_tabs": {
        const tabs = await listBrowserTabs();
        return {
          success: true,
          tabs,
          count: tabs.length,
          data: tabs,
          content: stringifyData(tabs),
        };
      }
      case "open_tab": {
        const tab = await openBrowserTab(params.url);
        return {
          success: true,
          data: tab,
          content: stringifyData(tab),
          message: `Opened tab ${tab.id}.`,
        };
      }
      case "close_tab": {
        const tabId = this.requireIdentifier(
          params.tabId,
          "tabId is required for close_tab",
        );
        await closeBrowserTab(tabId);
        return {
          success: true,
          message: `Closed tab ${tabId}.`,
        };
      }
      case "switch_tab": {
        const tabId = this.requireIdentifier(
          params.tabId,
          "tabId is required for switch_tab",
        );
        const state = await switchBrowserTab(tabId);
        return {
          success: true,
          url: state.url,
          title: state.title,
          isOpen: true,
          is_open: true,
          data: state,
          content: stringifyData(state),
          message: `Switched to tab ${tabId}.`,
        };
      }
      default:
        return {
          success: false,
          error: `Unknown browser action: ${(params as { action: string }).action}`,
        };
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
          const windows = refreshWindows();
          return this.succeedEntry(entry, {
            success: true,
            windows,
            count: windows.length,
          });
        }
        case "focus":
          await focusWindow(this.requireWindowTarget(params));
          return this.succeedEntry(entry, {
            success: true,
            message: "Focused window.",
          });
        case "switch":
          await switchWindow(this.requireWindowTarget(params));
          return this.succeedEntry(entry, {
            success: true,
            message: "Switched window.",
          });
        case "arrange":
          return this.succeedEntry(
            entry,
            await arrangeWindows(params.arrangement),
          );
        case "move": {
          const result = await moveWindow(
            this.requireWindowTarget(params),
            this.requireNumber(params.x, "x is required for window move"),
            this.requireNumber(params.y, "y is required for window move"),
          );
          return this.succeedEntry(entry, result);
        }
        case "minimize":
          await minimizeWindow(this.requireWindowTarget(params));
          return this.succeedEntry(entry, {
            success: true,
            message: "Window minimized.",
          });
        case "maximize":
          await maximizeWindow(this.requireWindowTarget(params));
          return this.succeedEntry(entry, {
            success: true,
            message: "Window maximized.",
          });
        case "restore":
          await restoreWindow(this.requireWindowTarget(params));
          return this.succeedEntry(entry, {
            success: true,
            message: "Window restored.",
          });
        case "close":
          await closeWindow(this.requireWindowTarget(params));
          return this.succeedEntry(entry, {
            success: true,
            message: "Window closed.",
          });
        case "get_current_window_id": {
          const active = await getActiveWindow();
          return this.succeedEntry(entry, {
            success: true,
            windowId: active?.id ?? null,
            window: active,
            message: active
              ? `Focused window: [${active.id}] ${active.app} - ${active.title}`
              : "No focused window.",
          });
        }
        case "get_application_windows": {
          const appName = params.appName ?? params.title ?? params.window;
          if (!appName) {
            throw new Error("appName is required for get_application_windows");
          }
          const windows = getApplicationWindows(appName);
          return this.succeedEntry(entry, {
            success: true,
            windows,
            count: windows.length,
          });
        }
        case "set_bounds": {
          const result = await resizeWindow(
            this.requireWindowTarget(params),
            this.requireNumber(params.x, "x is required for set_bounds"),
            this.requireNumber(params.y, "y is required for set_bounds"),
            params.width,
            params.height,
          );
          return this.succeedEntry(entry, result);
        }
        case "get_window_size":
        case "get_window_position": {
          // windowId is optional — defaults to the focused/foreground window.
          const bounds = await getWindowBounds(params.windowId);
          return this.succeedEntry(entry, {
            success: true,
            bounds,
            message:
              params.action === "get_window_size"
                ? `Window size: ${bounds.width}x${bounds.height}.`
                : `Window position: (${bounds.x}, ${bounds.y}).`,
          });
        }
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
        case "read_bytes":
          return this.finishFileEntry(
            entry,
            await readBytes(targetPath, params.offset, params.length),
          );
        case "write_bytes":
          if (typeof params.base64 !== "string") {
            throw new Error("base64 is required for file write_bytes");
          }
          return this.finishFileEntry(
            entry,
            await writeBytes(targetPath, params.base64),
          );
        case "create_dir":
          return this.finishFileEntry(entry, await createDirectory(targetPath));
        case "directory_exists":
          return this.finishFileEntry(entry, await directoryExists(targetPath));
        case "get_file_size":
          return this.finishFileEntry(entry, await getFileSize(targetPath));
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

  getConfig(): ComputerUseConfig {
    return {
      ...this.cuConfig,
      sandbox: this.cuConfig.sandbox
        ? {
            ...this.cuConfig.sandbox,
            options: this.cuConfig.sandbox.options
              ? { ...this.cuConfig.sandbox.options }
              : undefined,
          }
        : undefined,
    };
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
      case "get_context":
        return "context";
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
      case "get_current_window_id":
      case "get_application_windows":
      case "get_window_size":
      case "get_window_position":
        // Read-only getters — auto-approve (mapped to the SAFE list_windows).
        return "list_windows";
      case "set_bounds":
        return "move_window";
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
      case "file_read_bytes":
        return "read_bytes";
      case "file_write_bytes":
        return "write_bytes";
      case "file_create_dir":
        return "create_dir";
      case "file_directory_exists":
        return "directory_exists";
      case "file_get_file_size":
        return "get_file_size";
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

  /**
   * Capture a specific display's frame as base64 PNG. Falls back to the
   * legacy single-display path if the per-display capture throws.
   */
  private async captureScreenshotForDisplay(
    displayId: number | undefined,
  ): Promise<{ base64: string; displayId: number }> {
    try {
      const result =
        displayId === undefined
          ? await capturePrimaryDisplay()
          : await captureDisplay(displayId);
      return {
        base64: result.frame.toString("base64"),
        displayId: result.display.id,
      };
    } catch (error) {
      logger.debug(
        `[computeruse] per-display capture failed (${errorMessage(error)}); falling back to driver capture`,
      );
      const buf = await driverCaptureScreenshot();
      return {
        base64: buf.toString("base64"),
        displayId: displayId ?? getPrimaryDisplay().id,
      };
    }
  }

  /**
   * Resolve which display a coordinate-bearing action targets.
   * Emits a deprecation warning when displayId is omitted on multi-monitor
   * setups; defaults to the primary display.
   */
  private resolveDisplayIdForAction(params: DesktopActionParams): number {
    const needsCoord = COORDINATE_BEARING_ACTIONS.has(params.action);
    if (params.displayId !== undefined) return params.displayId;
    if (!needsCoord) return getPrimaryDisplay().id;
    if (!this.displayIdDeprecationWarned) {
      this.displayIdDeprecationWarned = true;
      const displays = listDisplays();
      if (displays.length > 1) {
        logger.warn(
          `[computeruse] DEPRECATED: action "${params.action}" was called without displayId on a ${displays.length}-display host. Defaulting to primary display ${getPrimaryDisplay().id}. Set displayId explicitly; this fallback will be removed.`,
        );
      } else {
        logger.debug(
          `[computeruse] action "${params.action}" omitted displayId; defaulting to primary on single-display host.`,
        );
      }
    }
    return getPrimaryDisplay().id;
  }

  private toGlobal(
    params: DesktopActionParams,
    coordinate: [number, number],
  ): { x: number; y: number } {
    return localToGlobalDefault(
      {
        displayId: params.displayId,
        x: coordinate[0],
        y: coordinate[1],
      },
      params.coordSource ?? "logical",
    );
  }

  /** Surface the live display layout for the agent state provider. */
  getDisplays(): DisplayDescriptor[] {
    return listDisplays().map((d) => ({
      id: d.id,
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      primary: d.primary,
      name: d.name,
    }));
  }

  /**
   * Return the most recently built Scene (WS6). Returns null before the
   * first tick. The `scene` provider seeds an initial tick on first read
   * so this is rarely null in practice.
   */
  getCurrentScene(): Scene | null {
    return this.sceneBuilder.getCurrentScene();
  }

  /**
   * Force a fresh Scene build. Used by the `scene` provider on first read
   * and by WS7's Brain to refresh before a new turn.
   */
  async refreshScene(
    mode: "idle" | "active" | "agent-turn" = "agent-turn",
  ): Promise<Scene> {
    // Pre-seed the window cache via the warm host so the (sync) listWindows the
    // scene's app enumeration runs hits a fresh cache instead of cold-spawning
    // powershell.exe (which, exceeding its timeout on Defender-heavy hosts,
    // would otherwise return an empty window list). No-op off Windows.
    await warmWindowsCache();
    return this.sceneBuilder.tick(mode);
  }

  /**
   * Subscribe to scene updates. Returns an unsubscribe function. The
   * SceneBuilder ticks only on explicit `refreshScene` calls — subscribers
   * are notified whenever a tick completes.
   */
  subscribeToSceneUpdates(
    handler: (event: SceneUpdateEvent) => void,
  ): () => void {
    return this.sceneBuilder.subscribe(handler);
  }

  /**
   * Shared single-capture `ScreenState` for a display (#9105 M3). Reuses the
   * last capture inside the freshness window; pass `force` to re-capture. This
   * is the one capture per turn that OCR, the Brain, and the DirtyTileDescriber
   * all read instead of grabbing their own frame.
   */
  async getScreenState(displayId = 0, force = false): Promise<ScreenState> {
    return this.screenStateStore.get(displayId, force);
  }

  /** Subscribe to screen-change events (dHash moved ≥ threshold). */
  subscribeScreenChange(
    listener: (change: ScreenStateChange) => void,
  ): () => void {
    return this.screenStateStore.onChange(listener);
  }

  /** Capture-accounting snapshot proving the per-turn capture saving. */
  getScreenStateStats(): ReturnType<ScreenStateStore["getStats"]> {
    return this.screenStateStore.getStats();
  }

  /**
   * Populate the current scene's VLM annotations (#9105 M3). The Brain and the
   * DirtyTileDescriber produce `vlm_scene` / `vlm_elements`; this persists them
   * so the next `scene` provider read carries the cheap understanding instead
   * of forcing a fresh describe.
   */
  setSceneVlmAnnotations(
    vlmScene: string | null,
    vlmElements: SceneVlmElement[] | null,
  ): void {
    this.sceneBuilder.setVlmAnnotations(vlmScene, vlmElements);
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
      return process.env[key] ?? process.env[`ELIZA_${key}`];
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

    const mode =
      getSetting("COMPUTERUSE_MODE") ?? getSetting("COMPUTER_USE_MODE");
    this.cuConfig.mode = mode === "sandbox" ? "sandbox" : "yolo";
    if (this.cuConfig.mode === "sandbox") {
      const backend =
        getSetting("COMPUTERUSE_SANDBOX_BACKEND") ??
        getSetting("COMPUTER_USE_SANDBOX_BACKEND");
      const image =
        getSetting("COMPUTERUSE_SANDBOX_IMAGE") ??
        getSetting("COMPUTER_USE_SANDBOX_IMAGE");
      const trimmedImage = image?.trim();
      // Remote-guest RPC options for the VM providers (#9170 M13).
      const rpcUrl = (
        getSetting("COMPUTERUSE_SANDBOX_RPC_URL") ??
        getSetting("COMPUTER_USE_SANDBOX_RPC_URL")
      )?.trim();
      const rpcPortRaw =
        getSetting("COMPUTERUSE_SANDBOX_RPC_PORT") ??
        getSetting("COMPUTER_USE_SANDBOX_RPC_PORT");
      const rpcPort = rpcPortRaw ? Number(rpcPortRaw) : undefined;
      const options =
        rpcUrl || (rpcPort !== undefined && Number.isFinite(rpcPort))
          ? {
              ...(rpcUrl ? { rpcUrl } : {}),
              ...(rpcPort !== undefined && Number.isFinite(rpcPort)
                ? { rpcPort }
                : {}),
            }
          : undefined;
      // docker + qemu require an image; wsb (Windows Sandbox) is imageless.
      if (
        (backend === "docker" || backend === "qemu") &&
        trimmedImage &&
        trimmedImage.length > 0
      ) {
        this.cuConfig.sandbox = {
          backend,
          image: trimmedImage,
          ...(options ? { options } : {}),
        };
      } else if (backend === "wsb") {
        this.cuConfig.sandbox = {
          backend,
          image:
            trimmedImage && trimmedImage.length > 0
              ? trimmedImage
              : "windows-sandbox",
          ...(options ? { options } : {}),
        };
      } else {
        this.cuConfig.sandbox = undefined;
      }
    } else {
      this.cuConfig.sandbox = undefined;
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
