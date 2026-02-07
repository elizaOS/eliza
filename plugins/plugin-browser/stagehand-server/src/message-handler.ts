import { z } from "zod";
import { detectCaptchaType } from "./captcha-handler.js";
import type { Logger } from "./logger.js";
import type { SessionManager, TabInfo } from "./session-manager.js";
import type { ConsoleMessage, PageError, NetworkRequest } from "./observability-manager.js";

// Stagehand v3 uses CDP-based types, not Playwright types directly
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type StagehandPage = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Cookie = any;

export interface MessageData {
  url?: string;
  description?: string;
  text?: string;
  field?: string;
  option?: string;
  dropdown?: string;
  instruction?: string;
  tabIndex?: number;
  selector?: string;
  timeout?: number;
  state?: string;
  script?: string;
  args?: unknown[];
  level?: string;
  filter?: string;
  clear?: boolean;
  cookies?: Partial<Cookie>[];
  key?: string;
  value?: string;
  keys?: string[];
  width?: number;
  height?: number;
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  offline?: boolean;
  media?: string;
  colorScheme?: string;
  reducedMotion?: string;
  forcedColors?: string;
  filePath?: string | string[];
  accept?: boolean;
  promptText?: string;
  format?: string;
  scale?: number;
  printBackground?: boolean;
  landscape?: boolean;
  pageRanges?: string;
  schema?: Record<string, unknown>;
  // Tracing
  screenshots?: boolean;
  snapshots?: boolean;
  sources?: boolean;
  path?: string;
  // Device emulation
  deviceName?: string;
  // Locale/timezone
  locale?: string;
  timezoneId?: string;
  // HTTP headers & auth
  headers?: Record<string, string>;
  username?: string;
  password?: string;
  // Frame selector
  frameSelector?: string;
  // Keyboard
  keyOrKeys?: string | string[];
  delay?: number;
  // Response body
  urlPattern?: string;
  maxChars?: number;
  // Highlight
  color?: string;
  duration?: number;
  [key: string]: unknown;
}

export interface Message {
  type: string;
  requestId: string;
  sessionId?: string;
  data?: MessageData;
}

export interface ResponseData {
  sessionId?: string;
  createdAt?: Date;
  url?: string;
  title?: string;
  description?: string;
  text?: string;
  field?: string;
  option?: string;
  dropdown?: string;
  screenshot?: string;
  mimeType?: string;
  status?: string | number;
  message?: string;
  captchaDetected?: boolean;
  captchaType?: string | null;
  siteKey?: string | null;
  data?: string;
  found?: boolean;
  tabs?: TabInfo[];
  tabId?: number;
  console?: ConsoleMessage[];
  errors?: PageError[];
  network?: NetworkRequest[];
  stats?: { consoleCount: number; errorCount: number; networkCount: number };
  cookies?: Cookie[];
  storage?: Record<string, string>;
  result?: unknown;
  elements?: Array<{ selector: string; text: string; attributes: Record<string, string> }>;
  observations?: Array<{ selector: string; description: string }>;
  dialogs?: Array<{ type: string; message: string }>;
  downloads?: Array<{ path: string; suggestedFilename: string; url: string }>;
  pdf?: string;
  [key: string]: unknown;
}

export interface Response {
  type: string;
  requestId: string;
  success: boolean;
  data?: ResponseData;
  error?: string;
}

export class MessageHandler {
  constructor(
    private sessionManager: SessionManager,
    private logger: Logger,
  ) {}

  async handleMessage(message: Message, clientId: string): Promise<Response> {
    const { type, requestId, sessionId, data } = message;

    try {
      switch (type) {
        // ─────────────────────────────────────────────────────────────────────
        // Core session & health
        // ─────────────────────────────────────────────────────────────────────
        case "health":
          return this.handleHealth(requestId);

        case "createSession":
          return await this.handleCreateSession(requestId, clientId);

        case "destroySession":
          return await this.handleDestroySession(requestId, sessionId!);

        // ─────────────────────────────────────────────────────────────────────
        // Navigation
        // ─────────────────────────────────────────────────────────────────────
        case "navigate":
          return await this.handleNavigate(requestId, sessionId!, data?.url ?? "", data?.tabIndex);

        case "goBack":
          return await this.handleGoBack(requestId, sessionId!, data?.tabIndex);

        case "goForward":
          return await this.handleGoForward(requestId, sessionId!, data?.tabIndex);

        case "refresh":
          return await this.handleRefresh(requestId, sessionId!, data?.tabIndex);

        // ─────────────────────────────────────────────────────────────────────
        // Multi-tab management
        // ─────────────────────────────────────────────────────────────────────
        case "listTabs":
          return await this.handleListTabs(requestId, sessionId!);

        case "createTab":
          return await this.handleCreateTab(requestId, sessionId!, data?.url);

        case "switchTab":
          return await this.handleSwitchTab(requestId, sessionId!, data?.tabIndex ?? 0);

        case "closeTab":
          return await this.handleCloseTab(requestId, sessionId!, data?.tabIndex ?? 0);

        // ─────────────────────────────────────────────────────────────────────
        // AI-powered actions (Stagehand)
        // ─────────────────────────────────────────────────────────────────────
        case "click":
          return await this.handleClick(
            requestId,
            sessionId!,
            data?.description ?? "",
          );

        case "type":
          return await this.handleType(
            requestId,
            sessionId!,
            data?.text ?? "",
            data?.field ?? "",
          );

        case "select":
          return await this.handleSelect(
            requestId,
            sessionId!,
            data?.option ?? "",
            data?.dropdown ?? "",
          );

        case "extract":
          return await this.handleExtract(
            requestId,
            sessionId!,
            data?.instruction ?? "",
            data?.schema,
          );

        case "observe":
          return await this.handleObserve(
            requestId,
            sessionId!,
            data?.instruction ?? "",
          );

        // ─────────────────────────────────────────────────────────────────────
        // Direct Playwright locator operations
        // ─────────────────────────────────────────────────────────────────────
        case "querySelector":
          return await this.handleQuerySelector(
            requestId,
            sessionId!,
            data?.selector ?? "",
            data?.tabIndex,
          );

        case "querySelectorAll":
          return await this.handleQuerySelectorAll(
            requestId,
            sessionId!,
            data?.selector ?? "",
            data?.tabIndex,
          );

        case "clickSelector":
          return await this.handleClickSelector(
            requestId,
            sessionId!,
            data?.selector ?? "",
            data?.tabIndex,
          );

        case "fillSelector":
          return await this.handleFillSelector(
            requestId,
            sessionId!,
            data?.selector ?? "",
            data?.text ?? "",
            data?.tabIndex,
          );

        case "hoverSelector":
          return await this.handleHoverSelector(
            requestId,
            sessionId!,
            data?.selector ?? "",
            data?.tabIndex,
          );

        // ─────────────────────────────────────────────────────────────────────
        // Wait operations
        // ─────────────────────────────────────────────────────────────────────
        case "waitForSelector":
          return await this.handleWaitForSelector(
            requestId,
            sessionId!,
            data?.selector ?? "",
            data?.timeout,
            data?.state as "attached" | "detached" | "visible" | "hidden" | undefined,
            data?.tabIndex,
          );

        case "waitForUrl":
          return await this.handleWaitForUrl(
            requestId,
            sessionId!,
            data?.url ?? "",
            data?.timeout,
            data?.tabIndex,
          );

        case "waitForLoadState":
          return await this.handleWaitForLoadState(
            requestId,
            sessionId!,
            data?.state as "load" | "domcontentloaded" | "networkidle" | undefined,
            data?.timeout,
            data?.tabIndex,
          );

        case "waitForTimeout":
          return await this.handleWaitForTimeout(
            requestId,
            sessionId!,
            data?.timeout ?? 1000,
          );

        // ─────────────────────────────────────────────────────────────────────
        // JavaScript evaluation
        // ─────────────────────────────────────────────────────────────────────
        case "evaluate":
          return await this.handleEvaluate(
            requestId,
            sessionId!,
            data?.script ?? "",
            data?.args,
            data?.tabIndex,
          );

        // ─────────────────────────────────────────────────────────────────────
        // Screenshots & PDF
        // ─────────────────────────────────────────────────────────────────────
        case "screenshot":
          return await this.handleScreenshot(requestId, sessionId!, data?.tabIndex);

        case "exportPdf":
          return await this.handleExportPdf(requestId, sessionId!, data);

        // ─────────────────────────────────────────────────────────────────────
        // Observability (console, errors, network)
        // ─────────────────────────────────────────────────────────────────────
        case "getConsole":
          return await this.handleGetConsole(requestId, sessionId!, data?.level);

        case "getErrors":
          return await this.handleGetErrors(requestId, sessionId!, data?.clear);

        case "getNetwork":
          return await this.handleGetNetwork(requestId, sessionId!, data?.filter, data?.clear);

        case "getObservabilityStats":
          return await this.handleGetObservabilityStats(requestId, sessionId!);

        // ─────────────────────────────────────────────────────────────────────
        // Storage (cookies, localStorage, sessionStorage)
        // ─────────────────────────────────────────────────────────────────────
        case "getCookies":
          return await this.handleGetCookies(requestId, sessionId!, data?.url);

        case "setCookies":
          return await this.handleSetCookies(requestId, sessionId!, data?.cookies ?? []);

        case "clearCookies":
          return await this.handleClearCookies(requestId, sessionId!);

        case "getLocalStorage":
          return await this.handleGetLocalStorage(requestId, sessionId!, data?.key, data?.tabIndex);

        case "setLocalStorage":
          return await this.handleSetLocalStorage(
            requestId,
            sessionId!,
            data?.key ?? "",
            data?.value ?? "",
            data?.tabIndex,
          );

        case "clearLocalStorage":
          return await this.handleClearLocalStorage(requestId, sessionId!, data?.keys, data?.tabIndex);

        case "getSessionStorage":
          return await this.handleGetSessionStorage(requestId, sessionId!, data?.key, data?.tabIndex);

        case "setSessionStorage":
          return await this.handleSetSessionStorage(
            requestId,
            sessionId!,
            data?.key ?? "",
            data?.value ?? "",
            data?.tabIndex,
          );

        // ─────────────────────────────────────────────────────────────────────
        // Environment emulation
        // ─────────────────────────────────────────────────────────────────────
        case "setViewport":
          return await this.handleSetViewport(
            requestId,
            sessionId!,
            data?.width ?? 1280,
            data?.height ?? 720,
            data?.tabIndex,
          );

        case "setGeolocation":
          return await this.handleSetGeolocation(
            requestId,
            sessionId!,
            data?.latitude ?? 0,
            data?.longitude ?? 0,
            data?.accuracy,
          );

        case "setOffline":
          return await this.handleSetOffline(requestId, sessionId!, data?.offline ?? false);

        case "emulateMedia":
          return await this.handleEmulateMedia(requestId, sessionId!, data);

        // ─────────────────────────────────────────────────────────────────────
        // File upload & dialogs
        // ─────────────────────────────────────────────────────────────────────
        case "uploadFile":
          return await this.handleUploadFile(
            requestId,
            sessionId!,
            data?.selector ?? "",
            data?.filePath ?? "",
            data?.tabIndex,
          );

        case "handleDialog":
          return await this.handleDialog(
            requestId,
            sessionId!,
            data?.accept ?? true,
            data?.promptText,
          );

        case "getDialogs":
          return await this.handleGetDialogs(requestId, sessionId!);

        // ─────────────────────────────────────────────────────────────────────
        // Downloads
        // ─────────────────────────────────────────────────────────────────────
        case "getDownloads":
          return await this.handleGetDownloads(requestId, sessionId!, data?.clear);

        // ─────────────────────────────────────────────────────────────────────
        // State & misc
        // ─────────────────────────────────────────────────────────────────────
        case "getState":
          return await this.handleGetState(requestId, sessionId!);

        case "solveCaptcha":
          return await this.handleSolveCaptcha(requestId, sessionId!);

        // ─────────────────────────────────────────────────────────────────────
        // Tracing (Otto parity)
        // ─────────────────────────────────────────────────────────────────────
        case "startTrace":
          return await this.handleStartTrace(requestId, sessionId!, data);

        case "stopTrace":
          return await this.handleStopTrace(requestId, sessionId!, data?.path);

        // ─────────────────────────────────────────────────────────────────────
        // Device & locale emulation (Otto parity)
        // ─────────────────────────────────────────────────────────────────────
        case "emulateDevice":
          return await this.handleEmulateDevice(requestId, sessionId!, data?.deviceName ?? "");

        case "setLocale":
          return await this.handleSetLocale(requestId, sessionId!, data?.locale ?? "en-US");

        case "setTimezone":
          return await this.handleSetTimezone(requestId, sessionId!, data?.timezoneId ?? "UTC");

        // ─────────────────────────────────────────────────────────────────────
        // HTTP headers & auth (Otto parity)
        // ─────────────────────────────────────────────────────────────────────
        case "setExtraHeaders":
          return await this.handleSetExtraHeaders(requestId, sessionId!, data?.headers ?? {});

        case "setHttpCredentials":
          return await this.handleSetHttpCredentials(
            requestId,
            sessionId!,
            data?.username,
            data?.password,
          );

        // ─────────────────────────────────────────────────────────────────────
        // Keyboard operations (Otto parity)
        // ─────────────────────────────────────────────────────────────────────
        case "press":
          return await this.handlePress(
            requestId,
            sessionId!,
            data?.keyOrKeys ?? "",
            data?.delay,
            data?.tabIndex,
          );

        // ─────────────────────────────────────────────────────────────────────
        // Frame operations (Otto parity)
        // ─────────────────────────────────────────────────────────────────────
        case "getFrames":
          return await this.handleGetFrames(requestId, sessionId!, data?.tabIndex);

        case "executeInFrame":
          return await this.handleExecuteInFrame(
            requestId,
            sessionId!,
            data?.frameSelector ?? "",
            data?.script ?? "",
            data?.args,
            data?.tabIndex,
          );

        // ─────────────────────────────────────────────────────────────────────
        // Response body capture (Otto parity)
        // ─────────────────────────────────────────────────────────────────────
        case "getResponseBody":
          return await this.handleGetResponseBody(
            requestId,
            sessionId!,
            data?.urlPattern ?? "",
            data?.timeout,
            data?.maxChars,
            data?.tabIndex,
          );

        // ─────────────────────────────────────────────────────────────────────
        // Highlight element (Otto parity)
        // ─────────────────────────────────────────────────────────────────────
        case "highlight":
          return await this.handleHighlight(
            requestId,
            sessionId!,
            data?.selector ?? "",
            data?.color,
            data?.duration,
            data?.tabIndex,
          );

        default:
          return {
            type: "error",
            requestId,
            success: false,
            error: `Unknown message type: ${type}`,
          };
      }
    } catch (error) {
      this.logger.error(`Error handling ${type}:`, error);
      return {
        type: "error",
        requestId,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Session management
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleCreateSession(
    requestId: string,
    clientId: string,
  ): Promise<Response> {
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const session = await this.sessionManager.createSession(
      sessionId,
      clientId,
    );

    return {
      type: "sessionCreated",
      requestId,
      success: true,
      data: {
        sessionId: session.id,
        createdAt: session.createdAt,
      },
    };
  }

  private async handleDestroySession(
    requestId: string,
    sessionId: string,
  ): Promise<Response> {
    await this.sessionManager.destroySession(sessionId);

    return {
      type: "sessionDestroyed",
      requestId,
      success: true,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Navigation
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleNavigate(
    requestId: string,
    sessionId: string,
    url: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    await page.goto(url);
    await page.waitForLoadState("domcontentloaded");

    const title = await page.title();
    const currentUrl = page.url();

    return {
      type: "navigated",
      requestId,
      success: true,
      data: {
        url: currentUrl,
        title,
      },
    };
  }

  private async handleGoBack(
    requestId: string,
    sessionId: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    await page.goBack();
    await page.waitForLoadState("domcontentloaded");

    const title = await page.title();
    const url = page.url();

    return {
      type: "wentBack",
      requestId,
      success: true,
      data: { url, title },
    };
  }

  private async handleGoForward(
    requestId: string,
    sessionId: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    await page.goForward();
    await page.waitForLoadState("domcontentloaded");

    const title = await page.title();
    const url = page.url();

    return {
      type: "wentForward",
      requestId,
      success: true,
      data: { url, title },
    };
  }

  private async handleRefresh(
    requestId: string,
    sessionId: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    await page.reload();
    await page.waitForLoadState("domcontentloaded");

    const title = await page.title();
    const url = page.url();

    return {
      type: "refreshed",
      requestId,
      success: true,
      data: { url, title },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Multi-tab management
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleListTabs(
    requestId: string,
    sessionId: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const tabs = await this.sessionManager.listTabs(session);

    return {
      type: "tabsList",
      requestId,
      success: true,
      data: { tabs },
    };
  }

  private async handleCreateTab(
    requestId: string,
    sessionId: string,
    url?: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const { tabId, page } = await this.sessionManager.createTab(session, url);
    const title = await page.title();
    const currentUrl = page.url();

    return {
      type: "tabCreated",
      requestId,
      success: true,
      data: { tabId, url: currentUrl, title },
    };
  }

  private async handleSwitchTab(
    requestId: string,
    sessionId: string,
    tabIndex: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = await this.sessionManager.switchTab(session, tabIndex);
    const title = await page.title();
    const url = page.url();

    return {
      type: "tabSwitched",
      requestId,
      success: true,
      data: { tabId: tabIndex, url, title },
    };
  }

  private async handleCloseTab(
    requestId: string,
    sessionId: string,
    tabIndex: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    await this.sessionManager.closeTab(session, tabIndex);

    return {
      type: "tabClosed",
      requestId,
      success: true,
      data: { tabId: tabIndex },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AI-powered actions (Stagehand)
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleClick(
    requestId: string,
    sessionId: string,
    description: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    // Stagehand v3: act(instruction: string)
    await session.stagehand.act(`click on ${description}`);

    return {
      type: "clicked",
      requestId,
      success: true,
      data: { description },
    };
  }

  private async handleType(
    requestId: string,
    sessionId: string,
    text: string,
    field: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    // Stagehand v3: act(instruction: string)
    await session.stagehand.act(`type "${text}" into ${field}`);

    return {
      type: "typed",
      requestId,
      success: true,
      data: { text, field },
    };
  }

  private async handleSelect(
    requestId: string,
    sessionId: string,
    option: string,
    dropdown: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    // Stagehand v3: act(instruction: string)
    await session.stagehand.act(`select "${option}" from ${dropdown}`);

    return {
      type: "selected",
      requestId,
      success: true,
      data: { option, dropdown },
    };
  }

  private async handleExtract(
    requestId: string,
    sessionId: string,
    instruction: string,
    customSchema?: Record<string, unknown>,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    // Stagehand v3: extract(instruction, schema) or extract(instruction)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let extractedData: any;

    if (customSchema) {
      const schema = z.object(customSchema as Record<string, z.ZodType>);
      extractedData = await session.stagehand.extract(instruction, schema);
    } else {
      // Default extraction returns { extraction: string }
      extractedData = await session.stagehand.extract(instruction);
    }

    return {
      type: "extracted",
      requestId,
      success: true,
      data: extractedData as ResponseData,
    };
  }

  private async handleObserve(
    requestId: string,
    sessionId: string,
    instruction: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    // Stagehand v3: observe(instruction: string) returns Action[]
    const observations = await session.stagehand.observe(instruction);

    return {
      type: "observed",
      requestId,
      success: true,
      data: {
        observations: observations.map((obs: { selector: string; description: string }) => ({
          selector: obs.selector,
          description: obs.description,
        })),
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Direct Playwright locator operations
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleQuerySelector(
    requestId: string,
    sessionId: string,
    selector: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    const element = await page.$(selector);

    if (!element) {
      return {
        type: "querySelector",
        requestId,
        success: true,
        data: { found: false },
      };
    }

    const text = await element.textContent();
    const attributes: Record<string, string> = {};
    const attrNames = await element.evaluate((el: Element) =>
      Array.from(el.attributes).map((a: Attr) => a.name),
    );
    for (const name of attrNames) {
      const value = await element.getAttribute(name);
      if (value !== null) {
        attributes[name] = value;
      }
    }

    return {
      type: "querySelector",
      requestId,
      success: true,
      data: {
        found: true,
        elements: [{ selector, text: text ?? "", attributes }],
      },
    };
  }

  private async handleQuerySelectorAll(
    requestId: string,
    sessionId: string,
    selector: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    const elements = await page.$$(selector);

    const results: Array<{
      selector: string;
      text: string;
      attributes: Record<string, string>;
    }> = [];

    for (const element of elements.slice(0, 100)) {
      // Limit to 100 elements
      const text = await element.textContent();
      const attributes: Record<string, string> = {};
      const attrNames = await element.evaluate((el: Element) =>
        Array.from(el.attributes).map((a: Attr) => a.name),
      );
      for (const name of attrNames) {
        const value = await element.getAttribute(name);
        if (value !== null) {
          attributes[name] = value;
        }
      }
      results.push({ selector, text: text ?? "", attributes });
    }

    return {
      type: "querySelectorAll",
      requestId,
      success: true,
      data: {
        found: results.length > 0,
        elements: results,
      },
    };
  }

  private async handleClickSelector(
    requestId: string,
    sessionId: string,
    selector: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    await page.click(selector);

    return {
      type: "clickedSelector",
      requestId,
      success: true,
      data: { selector },
    };
  }

  private async handleFillSelector(
    requestId: string,
    sessionId: string,
    selector: string,
    text: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    await page.fill(selector, text);

    return {
      type: "filledSelector",
      requestId,
      success: true,
      data: { selector, text },
    };
  }

  private async handleHoverSelector(
    requestId: string,
    sessionId: string,
    selector: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    await page.hover(selector);

    return {
      type: "hoveredSelector",
      requestId,
      success: true,
      data: { selector },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Wait operations
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleWaitForSelector(
    requestId: string,
    sessionId: string,
    selector: string,
    timeout?: number,
    state?: "attached" | "detached" | "visible" | "hidden",
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    await page.waitForSelector(selector, {
      timeout: timeout ?? 30000,
      state: state ?? "visible",
    });

    return {
      type: "waitedForSelector",
      requestId,
      success: true,
      data: { selector },
    };
  }

  private async handleWaitForUrl(
    requestId: string,
    sessionId: string,
    urlPattern: string,
    timeout?: number,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    await page.waitForURL(urlPattern, { timeout: timeout ?? 30000 });
    const url = page.url();
    const title = await page.title();

    return {
      type: "waitedForUrl",
      requestId,
      success: true,
      data: { url, title },
    };
  }

  private async handleWaitForLoadState(
    requestId: string,
    sessionId: string,
    state?: "load" | "domcontentloaded" | "networkidle",
    timeout?: number,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    await page.waitForLoadState(state ?? "load", { timeout: timeout ?? 30000 });

    return {
      type: "waitedForLoadState",
      requestId,
      success: true,
      data: { state: state ?? "load" },
    };
  }

  private async handleWaitForTimeout(
    requestId: string,
    sessionId: string,
    timeout: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session);
    // V3 CDP-based page - use evaluate for timeout
    await new Promise((resolve) => setTimeout(resolve, timeout));

    return {
      type: "waitedForTimeout",
      requestId,
      success: true,
      data: { timeout },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // JavaScript evaluation
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleEvaluate(
    requestId: string,
    sessionId: string,
    script: string,
    args?: unknown[],
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);

    // Create a function from the script and call with args
    const result = await page.evaluate(
      ({ code, arguments: evalArgs }: { code: string; arguments: unknown[] }) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function("...args", code);
        return fn(...evalArgs);
      },
      { code: script, arguments: args ?? [] },
    );

    return {
      type: "evaluated",
      requestId,
      success: true,
      data: { result },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Screenshots & PDF
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleScreenshot(
    requestId: string,
    sessionId: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    const screenshot = await page.screenshot({
      type: "png",
      fullPage: true,
    });

    const base64Screenshot = screenshot.toString("base64");
    const url = page.url();
    const title = await page.title();

    return {
      type: "screenshot",
      requestId,
      success: true,
      data: {
        screenshot: base64Screenshot,
        mimeType: "image/png",
        url,
        title,
      },
    };
  }

  private async handleExportPdf(
    requestId: string,
    sessionId: string,
    options?: MessageData,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, options?.tabIndex);

    const pdfBuffer = await page.pdf({
      format: (options?.format as "A4" | "Letter" | undefined) ?? "A4",
      scale: options?.scale ?? 1,
      printBackground: options?.printBackground ?? true,
      landscape: options?.landscape ?? false,
      pageRanges: options?.pageRanges,
    });

    const base64Pdf = pdfBuffer.toString("base64");

    return {
      type: "pdfExported",
      requestId,
      success: true,
      data: {
        pdf: base64Pdf,
        mimeType: "application/pdf",
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Observability (console, errors, network)
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleGetConsole(
    requestId: string,
    sessionId: string,
    level?: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const messages = session.observability.getConsoleMessages(level);

    return {
      type: "console",
      requestId,
      success: true,
      data: { console: messages },
    };
  }

  private async handleGetErrors(
    requestId: string,
    sessionId: string,
    clear?: boolean,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const errors = session.observability.getPageErrors(clear);

    return {
      type: "errors",
      requestId,
      success: true,
      data: { errors },
    };
  }

  private async handleGetNetwork(
    requestId: string,
    sessionId: string,
    filter?: string,
    clear?: boolean,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const requests = session.observability.getNetworkRequests(filter, clear);

    return {
      type: "network",
      requestId,
      success: true,
      data: { network: requests },
    };
  }

  private async handleGetObservabilityStats(
    requestId: string,
    sessionId: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const stats = session.observability.getStats();

    return {
      type: "observabilityStats",
      requestId,
      success: true,
      data: { stats },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Storage (cookies, localStorage, sessionStorage)
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleGetCookies(
    requestId: string,
    sessionId: string,
    url?: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const context = this.sessionManager.getContext(session);
    const cookies = url
      ? await context.cookies(url)
      : await context.cookies();

    return {
      type: "cookies",
      requestId,
      success: true,
      data: { cookies },
    };
  }

  private async handleSetCookies(
    requestId: string,
    sessionId: string,
    cookies: Partial<Cookie>[],
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const context = this.sessionManager.getContext(session);
    // Filter to only valid cookies with required fields
    // Cookie requires name, value, and either url OR (domain + path)
    const validCookies: Cookie[] = [];
    for (const c of cookies) {
      if (typeof c.name !== "string" || typeof c.value !== "string") {
        continue;
      }
      const hasUrl = "url" in c && typeof c.url === "string";
      const hasDomainPath =
        "domain" in c &&
        typeof c.domain === "string" &&
        "path" in c &&
        typeof c.path === "string";
      if (hasUrl || hasDomainPath) {
        validCookies.push(c as Cookie);
      }
    }
    await context.addCookies(validCookies);

    return {
      type: "cookiesSet",
      requestId,
      success: true,
    };
  }

  private async handleClearCookies(
    requestId: string,
    sessionId: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const context = this.sessionManager.getContext(session);
    await context.clearCookies();

    return {
      type: "cookiesCleared",
      requestId,
      success: true,
    };
  }

  private async handleGetLocalStorage(
    requestId: string,
    sessionId: string,
    key?: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);

    const storage = await page.evaluate((storageKey: string | undefined) => {
      if (storageKey) {
        const value = localStorage.getItem(storageKey);
        return value !== null ? { [storageKey]: value } : {};
      }
      const result: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k) {
          result[k] = localStorage.getItem(k) ?? "";
        }
      }
      return result;
    }, key);

    return {
      type: "localStorage",
      requestId,
      success: true,
      data: { storage },
    };
  }

  private async handleSetLocalStorage(
    requestId: string,
    sessionId: string,
    key: string,
    value: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);

    await page.evaluate(
      ({ k, v }: { k: string; v: string }) => {
        localStorage.setItem(k, v);
      },
      { k: key, v: value },
    );

    return {
      type: "localStorageSet",
      requestId,
      success: true,
      data: { key, value },
    };
  }

  private async handleClearLocalStorage(
    requestId: string,
    sessionId: string,
    keys?: string[],
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);

    await page.evaluate((keysToRemove: string[] | undefined) => {
      if (keysToRemove && keysToRemove.length > 0) {
        for (const k of keysToRemove) {
          localStorage.removeItem(k);
        }
      } else {
        localStorage.clear();
      }
    }, keys);

    return {
      type: "localStorageCleared",
      requestId,
      success: true,
    };
  }

  private async handleGetSessionStorage(
    requestId: string,
    sessionId: string,
    key?: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);

    const storage = await page.evaluate((storageKey: string | undefined) => {
      if (storageKey) {
        const value = sessionStorage.getItem(storageKey);
        return value !== null ? { [storageKey]: value } : {};
      }
      const result: Record<string, string> = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k) {
          result[k] = sessionStorage.getItem(k) ?? "";
        }
      }
      return result;
    }, key);

    return {
      type: "sessionStorage",
      requestId,
      success: true,
      data: { storage },
    };
  }

  private async handleSetSessionStorage(
    requestId: string,
    sessionId: string,
    key: string,
    value: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);

    await page.evaluate(
      ({ k, v }: { k: string; v: string }) => {
        sessionStorage.setItem(k, v);
      },
      { k: key, v: value },
    );

    return {
      type: "sessionStorageSet",
      requestId,
      success: true,
      data: { key, value },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Environment emulation
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleSetViewport(
    requestId: string,
    sessionId: string,
    width: number,
    height: number,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    await page.setViewportSize({ width, height });

    return {
      type: "viewportSet",
      requestId,
      success: true,
      data: { width, height },
    };
  }

  private async handleSetGeolocation(
    requestId: string,
    sessionId: string,
    latitude: number,
    longitude: number,
    accuracy?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const context = this.sessionManager.getContext(session);
    await context.setGeolocation({
      latitude,
      longitude,
      accuracy: accuracy ?? 100,
    });

    return {
      type: "geolocationSet",
      requestId,
      success: true,
      data: { latitude, longitude, accuracy: accuracy ?? 100 },
    };
  }

  private async handleSetOffline(
    requestId: string,
    sessionId: string,
    offline: boolean,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const context = this.sessionManager.getContext(session);
    await context.setOffline(offline);

    return {
      type: "offlineSet",
      requestId,
      success: true,
      data: { offline },
    };
  }

  private async handleEmulateMedia(
    requestId: string,
    sessionId: string,
    options?: MessageData,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, options?.tabIndex);

    await page.emulateMedia({
      media: options?.media as "screen" | "print" | null | undefined,
      colorScheme: options?.colorScheme as
        | "light"
        | "dark"
        | "no-preference"
        | null
        | undefined,
      reducedMotion: options?.reducedMotion as
        | "reduce"
        | "no-preference"
        | null
        | undefined,
      forcedColors: options?.forcedColors as "active" | "none" | null | undefined,
    });

    return {
      type: "mediaEmulated",
      requestId,
      success: true,
      data: {
        media: options?.media,
        colorScheme: options?.colorScheme,
        reducedMotion: options?.reducedMotion,
        forcedColors: options?.forcedColors,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // File upload & dialogs
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleUploadFile(
    requestId: string,
    sessionId: string,
    selector: string,
    filePath: string | string[],
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    const fileInput = await page.$(selector);

    if (!fileInput) {
      return {
        type: "error",
        requestId,
        success: false,
        error: `File input not found: ${selector}`,
      };
    }

    await fileInput.setInputFiles(filePath);

    return {
      type: "fileUploaded",
      requestId,
      success: true,
      data: { selector, filePath: Array.isArray(filePath) ? filePath : [filePath] },
    };
  }

  private async handleDialog(
    requestId: string,
    sessionId: string,
    accept: boolean,
    promptText?: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const dialog = session.pendingDialogs.shift();
    if (!dialog) {
      return {
        type: "error",
        requestId,
        success: false,
        error: "No pending dialog to handle",
      };
    }

    if (accept) {
      await dialog.accept(promptText);
    } else {
      await dialog.dismiss();
    }

    return {
      type: "dialogHandled",
      requestId,
      success: true,
      data: {
        accept,
        promptText,
        message: dialog.message(),
      },
    };
  }

  private async handleGetDialogs(
    requestId: string,
    sessionId: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const dialogs = session.pendingDialogs.map((d) => ({
      type: d.type(),
      message: d.message(),
    }));

    return {
      type: "dialogs",
      requestId,
      success: true,
      data: { dialogs },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Downloads
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleGetDownloads(
    requestId: string,
    sessionId: string,
    clear?: boolean,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const downloads = [...session.pendingDownloads];

    if (clear) {
      session.pendingDownloads = [];
    }

    return {
      type: "downloads",
      requestId,
      success: true,
      data: { downloads },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // State & captcha
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleGetState(
    requestId: string,
    sessionId: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session);
    // V3 uses evaluate to get URL and title
    let url = "about:blank";
    let title = "Untitled";
    try {
      url = await page.evaluate(() => window.location.href);
      title = await page.evaluate(() => document.title);
    } catch {
      // Page might not be ready
    }
    const tabs = await this.sessionManager.listTabs(session);
    const observabilityStats = session.observability.getStats();

    return {
      type: "state",
      requestId,
      success: true,
      data: {
        url,
        title,
        sessionId,
        createdAt: session.createdAt,
        tabs,
        stats: observabilityStats,
      },
    };
  }

  private async handleSolveCaptcha(
    requestId: string,
    sessionId: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session);
    const captchaInfo = await detectCaptchaType(page);

    return {
      type: "captchaSolved",
      requestId,
      success: captchaInfo.type !== null,
      data: {
        captchaDetected: captchaInfo.type !== null,
        captchaType: captchaInfo.type,
        siteKey: captchaInfo.siteKey,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tracing (Otto parity)
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleStartTrace(
    requestId: string,
    sessionId: string,
    options?: MessageData,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const context = this.sessionManager.getContext(session);
    await context.tracing.start({
      screenshots: options?.screenshots ?? true,
      snapshots: options?.snapshots ?? true,
      sources: options?.sources ?? false,
    });

    return {
      type: "traceStarted",
      requestId,
      success: true,
    };
  }

  private async handleStopTrace(
    requestId: string,
    sessionId: string,
    path?: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const context = this.sessionManager.getContext(session);
    const tracePath = path ?? `trace-${Date.now()}.zip`;
    await context.tracing.stop({ path: tracePath });

    return {
      type: "traceStopped",
      requestId,
      success: true,
      data: { path: tracePath },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Device & locale emulation (Otto parity)
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleEmulateDevice(
    requestId: string,
    sessionId: string,
    deviceName: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    // Import playwright devices for device specs
    const { devices } = await import("playwright");
    const device = devices[deviceName];

    if (!device) {
      return {
        type: "error",
        requestId,
        success: false,
        error: `Unknown device: ${deviceName}. Available devices: ${Object.keys(devices).slice(0, 10).join(", ")}...`,
      };
    }

    const page = this.sessionManager.getPage(session);

    // V3 uses CDP commands for device emulation
    // Apply viewport via CDP Emulation.setDeviceMetricsOverride
    if (device.viewport) {
      await page.session?.send("Emulation.setDeviceMetricsOverride", {
        width: device.viewport.width,
        height: device.viewport.height,
        deviceScaleFactor: device.deviceScaleFactor || 1,
        mobile: device.isMobile || false,
      });
    }

    // Apply user agent via CDP
    if (device.userAgent) {
      await page.session?.send("Emulation.setUserAgentOverride", {
        userAgent: device.userAgent,
      });
    }

    return {
      type: "deviceEmulated",
      requestId,
      success: true,
      data: {
        deviceName,
        viewport: device.viewport,
        userAgent: device.userAgent,
      },
    };
  }

  private async handleSetLocale(
    requestId: string,
    sessionId: string,
    locale: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session);

    try {
      // V3 uses CDP for locale emulation
      await page.session?.send("Emulation.setLocaleOverride", { locale });
    } catch {
      // Locale override might not be supported
      this.logger.warn(`Locale override not supported, locale: ${locale}`);
    }

    return {
      type: "localeSet",
      requestId,
      success: true,
      data: { locale },
    };
  }

  private async handleSetTimezone(
    requestId: string,
    sessionId: string,
    timezoneId: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session);

    try {
      // V3 uses CDP for timezone emulation
      await page.session?.send("Emulation.setTimezoneOverride", { timezoneId });
    } catch (error) {
      return {
        type: "error",
        requestId,
        success: false,
        error: `Invalid timezone: ${timezoneId}`,
      };
    }

    return {
      type: "timezoneSet",
      requestId,
      success: true,
      data: { timezoneId },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HTTP headers & auth (Otto parity)
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleSetExtraHeaders(
    requestId: string,
    sessionId: string,
    headers: Record<string, string>,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const context = this.sessionManager.getContext(session);
    await context.setExtraHTTPHeaders(headers);

    return {
      type: "headersSet",
      requestId,
      success: true,
      data: { headers },
    };
  }

  private async handleSetHttpCredentials(
    requestId: string,
    sessionId: string,
    username?: string,
    password?: string,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const context = this.sessionManager.getContext(session);

    if (username && password) {
      await context.setHTTPCredentials({ username, password });
    } else {
      // Clear credentials
      await context.setHTTPCredentials(null);
    }

    return {
      type: "credentialsSet",
      requestId,
      success: true,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Keyboard operations (Otto parity)
  // ═══════════════════════════════════════════════════════════════════════════

  private async handlePress(
    requestId: string,
    sessionId: string,
    keyOrKeys: string | string[],
    delay?: number,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];

    for (const key of keys) {
      await page.keyboard.press(key, { delay });
    }

    return {
      type: "pressed",
      requestId,
      success: true,
      data: { keys },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Frame operations (Otto parity)
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleGetFrames(
    requestId: string,
    sessionId: string,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    const frames = page.frames?.() ?? [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const frameInfos = frames.map((frame: any, index: number) => ({
      index,
      name: frame.name?.() ?? "",
      url: frame.url?.() ?? "",
      isMain: frame === page.mainFrame?.(),
    }));

    return {
      type: "frames",
      requestId,
      success: true,
      data: { frames: frameInfos },
    };
  }

  private async handleExecuteInFrame(
    requestId: string,
    sessionId: string,
    frameSelector: string,
    script: string,
    args?: unknown[],
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);

    // Find frame by selector or name
    const frames = page.frames?.() ?? [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let targetFrame = frames.find((f: any) => f.name?.() === frameSelector);

    if (!targetFrame) {
      // Try to find by iframe selector
      const frameElement = await page.$(frameSelector);
      if (frameElement) {
        const frame = await frameElement.contentFrame?.();
        if (frame) {
          targetFrame = frame;
        }
      }
    }

    if (!targetFrame) {
      return {
        type: "error",
        requestId,
        success: false,
        error: `Frame not found: ${frameSelector}`,
      };
    }

    const result = await targetFrame.evaluate(
      ({ code, arguments: evalArgs }: { code: string; arguments: unknown[] }) => {
        // eslint-disable-next-line no-new-func
        const fn = new Function("...args", code);
        return fn(...evalArgs);
      },
      { code: script, arguments: args ?? [] },
    );

    return {
      type: "frameEvaluated",
      requestId,
      success: true,
      data: { result },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Response body capture (Otto parity)
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleGetResponseBody(
    requestId: string,
    sessionId: string,
    urlPattern: string,
    timeout?: number,
    maxChars?: number,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);

    // Wait for a matching response
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = await page.waitForResponse?.(
      (res: { url: () => string }) => {
        const url = res.url();
        // Simple wildcard matching
        if (urlPattern.includes("*")) {
          const pattern = urlPattern.replace(/\*/g, ".*");
          return new RegExp(pattern).test(url);
        }
        return url.includes(urlPattern);
      },
      { timeout: timeout ?? 30000 },
    );

    let body = await response.text();

    // Truncate if needed
    const max = maxChars ?? 100000;
    if (body.length > max) {
      body = body.substring(0, max) + "... [truncated]";
    }

    return {
      type: "responseBody",
      requestId,
      success: true,
      data: {
        url: response.url(),
        status: response.status(),
        body,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Highlight element (Otto parity)
  // ═══════════════════════════════════════════════════════════════════════════

  private async handleHighlight(
    requestId: string,
    sessionId: string,
    selector: string,
    color?: string,
    duration?: number,
    tabIndex?: number,
  ): Promise<Response> {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      return this.sessionNotFoundResponse(requestId);
    }

    const page = this.sessionManager.getPage(session, tabIndex);
    const highlightColor = color ?? "rgba(255, 0, 0, 0.3)";
    const highlightDuration = duration ?? 2000;

    await page.evaluate(
      ({ sel, bgColor, dur }: { sel: string; bgColor: string; dur: number }) => {
        const element = document.querySelector(sel);
        if (element instanceof HTMLElement) {
          const originalBg = element.style.backgroundColor;
          const originalOutline = element.style.outline;

          element.style.backgroundColor = bgColor;
          element.style.outline = "2px solid red";

          setTimeout(() => {
            element.style.backgroundColor = originalBg;
            element.style.outline = originalOutline;
          }, dur);
        }
      },
      { sel: selector, bgColor: highlightColor, dur: highlightDuration },
    );

    return {
      type: "highlighted",
      requestId,
      success: true,
      data: { selector, color: highlightColor, duration: highlightDuration },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Helper methods
  // ═══════════════════════════════════════════════════════════════════════════

  private sessionNotFoundResponse(requestId: string): Response {
    return {
      type: "error",
      requestId,
      success: false,
      error: "Session not found",
    };
  }

  private handleHealth(requestId: string): Response {
    return {
      type: "health",
      requestId,
      success: true,
      data: {
        status: "ok",
      },
    };
  }
}
