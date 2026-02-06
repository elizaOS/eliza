/**
 * Stagehand Server WebSocket API Types
 *
 * This file documents all message types supported by the stagehand-server
 * WebSocket API. Messages follow a request/response pattern with requestId
 * for correlation.
 */

import type { Cookie } from "playwright";

// ═══════════════════════════════════════════════════════════════════════════════
// Base message types
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Base request message structure
 */
export interface BaseRequest {
  /** Message type identifier */
  type: string;
  /** Unique request ID for response correlation */
  requestId: string;
  /** Session ID (required for most operations after createSession) */
  sessionId?: string;
}

/**
 * Base response message structure
 */
export interface BaseResponse {
  /** Response type (usually matches request type or "error") */
  type: string;
  /** Request ID this response correlates to */
  requestId: string;
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if success is false */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Session management
// ═══════════════════════════════════════════════════════════════════════════════

/** Health check request */
export interface HealthRequest extends BaseRequest {
  type: "health";
}

/** Health check response */
export interface HealthResponse extends BaseResponse {
  type: "health";
  data: { status: "ok" };
}

/** Create browser session request */
export interface CreateSessionRequest extends BaseRequest {
  type: "createSession";
}

/** Create browser session response */
export interface CreateSessionResponse extends BaseResponse {
  type: "sessionCreated";
  data: {
    sessionId: string;
    createdAt: Date;
  };
}

/** Destroy browser session request */
export interface DestroySessionRequest extends BaseRequest {
  type: "destroySession";
  sessionId: string;
}

/** Destroy browser session response */
export interface DestroySessionResponse extends BaseResponse {
  type: "sessionDestroyed";
}

// ═══════════════════════════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════════════════════════

/** Navigate to URL request */
export interface NavigateRequest extends BaseRequest {
  type: "navigate";
  sessionId: string;
  data: {
    /** URL to navigate to */
    url: string;
    /** Optional tab index for multi-tab navigation */
    tabIndex?: number;
  };
}

/** Navigate response */
export interface NavigateResponse extends BaseResponse {
  type: "navigated";
  data: {
    url: string;
    title: string;
  };
}

/** Go back in history request */
export interface GoBackRequest extends BaseRequest {
  type: "goBack";
  sessionId: string;
  data?: { tabIndex?: number };
}

/** Go forward in history request */
export interface GoForwardRequest extends BaseRequest {
  type: "goForward";
  sessionId: string;
  data?: { tabIndex?: number };
}

/** Refresh page request */
export interface RefreshRequest extends BaseRequest {
  type: "refresh";
  sessionId: string;
  data?: { tabIndex?: number };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Multi-tab management
// ═══════════════════════════════════════════════════════════════════════════════

/** Tab information */
export interface TabInfo {
  /** Tab index (0-based) */
  id: number;
  /** Current URL */
  url: string;
  /** Page title */
  title: string;
  /** Whether this is the active tab */
  isActive: boolean;
}

/** List all tabs request */
export interface ListTabsRequest extends BaseRequest {
  type: "listTabs";
  sessionId: string;
}

/** List tabs response */
export interface ListTabsResponse extends BaseResponse {
  type: "tabsList";
  data: { tabs: TabInfo[] };
}

/** Create new tab request */
export interface CreateTabRequest extends BaseRequest {
  type: "createTab";
  sessionId: string;
  data?: {
    /** Optional URL to navigate to in new tab */
    url?: string;
  };
}

/** Create tab response */
export interface CreateTabResponse extends BaseResponse {
  type: "tabCreated";
  data: {
    tabId: number;
    url: string;
    title: string;
  };
}

/** Switch to tab request */
export interface SwitchTabRequest extends BaseRequest {
  type: "switchTab";
  sessionId: string;
  data: {
    /** Tab index to switch to */
    tabIndex: number;
  };
}

/** Close tab request */
export interface CloseTabRequest extends BaseRequest {
  type: "closeTab";
  sessionId: string;
  data: {
    /** Tab index to close */
    tabIndex: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// AI-powered actions (Stagehand)
// ═══════════════════════════════════════════════════════════════════════════════

/** AI click request - uses natural language to find and click element */
export interface ClickRequest extends BaseRequest {
  type: "click";
  sessionId: string;
  data: {
    /** Natural language description of element to click */
    description: string;
  };
}

/** AI type request - uses natural language to find field and type text */
export interface TypeRequest extends BaseRequest {
  type: "type";
  sessionId: string;
  data: {
    /** Text to type */
    text: string;
    /** Natural language description of the input field */
    field: string;
  };
}

/** AI select request - uses natural language for dropdown selection */
export interface SelectRequest extends BaseRequest {
  type: "select";
  sessionId: string;
  data: {
    /** Option to select */
    option: string;
    /** Natural language description of the dropdown */
    dropdown: string;
  };
}

/** AI extract request - extracts structured data from page */
export interface ExtractRequest extends BaseRequest {
  type: "extract";
  sessionId: string;
  data: {
    /** Natural language instruction for what to extract */
    instruction: string;
    /** Optional custom Zod schema for extraction */
    schema?: Record<string, unknown>;
  };
}

/** Extract response */
export interface ExtractResponse extends BaseResponse {
  type: "extracted";
  data: {
    data?: string;
    found?: boolean;
    [key: string]: unknown;
  };
}

/** AI observe request - identifies interactive elements matching description */
export interface ObserveRequest extends BaseRequest {
  type: "observe";
  sessionId: string;
  data: {
    /** Natural language instruction for what to observe */
    instruction: string;
  };
}

/** Observe response */
export interface ObserveResponse extends BaseResponse {
  type: "observed";
  data: {
    observations: Array<{
      /** XPath or CSS selector for the element */
      selector: string;
      /** AI-generated description of the element */
      description: string;
    }>;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Direct Playwright locator operations
// ═══════════════════════════════════════════════════════════════════════════════

/** Query selector request */
export interface QuerySelectorRequest extends BaseRequest {
  type: "querySelector";
  sessionId: string;
  data: {
    /** CSS or XPath selector */
    selector: string;
    tabIndex?: number;
  };
}

/** Query selector all request */
export interface QuerySelectorAllRequest extends BaseRequest {
  type: "querySelectorAll";
  sessionId: string;
  data: {
    selector: string;
    tabIndex?: number;
  };
}

/** Element result */
export interface ElementResult {
  selector: string;
  text: string;
  attributes: Record<string, string>;
}

/** Query selector response */
export interface QuerySelectorResponse extends BaseResponse {
  type: "querySelector" | "querySelectorAll";
  data: {
    found: boolean;
    elements?: ElementResult[];
  };
}

/** Click selector request - direct click by selector */
export interface ClickSelectorRequest extends BaseRequest {
  type: "clickSelector";
  sessionId: string;
  data: {
    selector: string;
    tabIndex?: number;
  };
}

/** Fill selector request - fill input by selector */
export interface FillSelectorRequest extends BaseRequest {
  type: "fillSelector";
  sessionId: string;
  data: {
    selector: string;
    text: string;
    tabIndex?: number;
  };
}

/** Hover selector request */
export interface HoverSelectorRequest extends BaseRequest {
  type: "hoverSelector";
  sessionId: string;
  data: {
    selector: string;
    tabIndex?: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Wait operations
// ═══════════════════════════════════════════════════════════════════════════════

/** Wait for selector request */
export interface WaitForSelectorRequest extends BaseRequest {
  type: "waitForSelector";
  sessionId: string;
  data: {
    selector: string;
    /** Timeout in milliseconds (default 30000) */
    timeout?: number;
    /** State to wait for: "attached" | "detached" | "visible" | "hidden" */
    state?: "attached" | "detached" | "visible" | "hidden";
    tabIndex?: number;
  };
}

/** Wait for URL request */
export interface WaitForUrlRequest extends BaseRequest {
  type: "waitForUrl";
  sessionId: string;
  data: {
    /** URL pattern (string or regex) */
    url: string;
    timeout?: number;
    tabIndex?: number;
  };
}

/** Wait for load state request */
export interface WaitForLoadStateRequest extends BaseRequest {
  type: "waitForLoadState";
  sessionId: string;
  data: {
    /** Load state: "load" | "domcontentloaded" | "networkidle" */
    state?: "load" | "domcontentloaded" | "networkidle";
    timeout?: number;
    tabIndex?: number;
  };
}

/** Wait for timeout request */
export interface WaitForTimeoutRequest extends BaseRequest {
  type: "waitForTimeout";
  sessionId: string;
  data: {
    /** Time to wait in milliseconds */
    timeout: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// JavaScript evaluation
// ═══════════════════════════════════════════════════════════════════════════════

/** Evaluate JavaScript in page context */
export interface EvaluateRequest extends BaseRequest {
  type: "evaluate";
  sessionId: string;
  data: {
    /** JavaScript code to execute (function body) */
    script: string;
    /** Arguments to pass to the script */
    args?: unknown[];
    tabIndex?: number;
  };
}

/** Evaluate response */
export interface EvaluateResponse extends BaseResponse {
  type: "evaluated";
  data: {
    result: unknown;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Screenshots & PDF
// ═══════════════════════════════════════════════════════════════════════════════

/** Take screenshot request */
export interface ScreenshotRequest extends BaseRequest {
  type: "screenshot";
  sessionId: string;
  data?: {
    tabIndex?: number;
  };
}

/** Screenshot response */
export interface ScreenshotResponse extends BaseResponse {
  type: "screenshot";
  data: {
    /** Base64-encoded PNG image */
    screenshot: string;
    mimeType: "image/png";
    url: string;
    title: string;
  };
}

/** Export page as PDF request */
export interface ExportPdfRequest extends BaseRequest {
  type: "exportPdf";
  sessionId: string;
  data?: {
    /** Paper format: "A4" | "Letter" etc. (default "A4") */
    format?: string;
    /** Scale (default 1) */
    scale?: number;
    /** Print background graphics (default true) */
    printBackground?: boolean;
    /** Landscape orientation (default false) */
    landscape?: boolean;
    /** Page ranges (e.g., "1-5, 8") */
    pageRanges?: string;
    tabIndex?: number;
  };
}

/** Export PDF response */
export interface ExportPdfResponse extends BaseResponse {
  type: "pdfExported";
  data: {
    /** Base64-encoded PDF */
    pdf: string;
    mimeType: "application/pdf";
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Observability (console, errors, network)
// ═══════════════════════════════════════════════════════════════════════════════

/** Console message captured from page */
export interface ConsoleMessage {
  type: string;
  text: string;
  timestamp: string;
  location?: {
    url?: string;
    lineNumber?: number;
    columnNumber?: number;
  };
}

/** Page error captured */
export interface PageError {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
}

/** Network request captured */
export interface NetworkRequest {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
  responseHeaders?: Record<string, string>;
  timing?: {
    startTime: number;
    endTime?: number;
    duration?: number;
  };
}

/** Get console messages request */
export interface GetConsoleRequest extends BaseRequest {
  type: "getConsole";
  sessionId: string;
  data?: {
    /** Minimum log level: "debug" | "info" | "warning" | "error" */
    level?: string;
  };
}

/** Get console response */
export interface GetConsoleResponse extends BaseResponse {
  type: "console";
  data: {
    console: ConsoleMessage[];
  };
}

/** Get page errors request */
export interface GetErrorsRequest extends BaseRequest {
  type: "getErrors";
  sessionId: string;
  data?: {
    /** Clear errors after retrieval */
    clear?: boolean;
  };
}

/** Get errors response */
export interface GetErrorsResponse extends BaseResponse {
  type: "errors";
  data: {
    errors: PageError[];
  };
}

/** Get network requests request */
export interface GetNetworkRequest extends BaseRequest {
  type: "getNetwork";
  sessionId: string;
  data?: {
    /** URL filter (case-insensitive contains) */
    filter?: string;
    /** Clear after retrieval */
    clear?: boolean;
  };
}

/** Get network response */
export interface GetNetworkResponse extends BaseResponse {
  type: "network";
  data: {
    network: NetworkRequest[];
  };
}

/** Get observability stats request */
export interface GetObservabilityStatsRequest extends BaseRequest {
  type: "getObservabilityStats";
  sessionId: string;
}

/** Get observability stats response */
export interface GetObservabilityStatsResponse extends BaseResponse {
  type: "observabilityStats";
  data: {
    stats: {
      consoleCount: number;
      errorCount: number;
      networkCount: number;
    };
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Storage (cookies, localStorage, sessionStorage)
// ═══════════════════════════════════════════════════════════════════════════════

/** Get cookies request */
export interface GetCookiesRequest extends BaseRequest {
  type: "getCookies";
  sessionId: string;
  data?: {
    /** Optional URL to filter cookies */
    url?: string;
  };
}

/** Get cookies response */
export interface GetCookiesResponse extends BaseResponse {
  type: "cookies";
  data: {
    cookies: Cookie[];
  };
}

/** Set cookies request */
export interface SetCookiesRequest extends BaseRequest {
  type: "setCookies";
  sessionId: string;
  data: {
    cookies: Partial<Cookie>[];
  };
}

/** Clear cookies request */
export interface ClearCookiesRequest extends BaseRequest {
  type: "clearCookies";
  sessionId: string;
}

/** Get localStorage request */
export interface GetLocalStorageRequest extends BaseRequest {
  type: "getLocalStorage";
  sessionId: string;
  data?: {
    /** Optional specific key to get */
    key?: string;
    tabIndex?: number;
  };
}

/** Get localStorage response */
export interface GetLocalStorageResponse extends BaseResponse {
  type: "localStorage";
  data: {
    storage: Record<string, string>;
  };
}

/** Set localStorage request */
export interface SetLocalStorageRequest extends BaseRequest {
  type: "setLocalStorage";
  sessionId: string;
  data: {
    key: string;
    value: string;
    tabIndex?: number;
  };
}

/** Clear localStorage request */
export interface ClearLocalStorageRequest extends BaseRequest {
  type: "clearLocalStorage";
  sessionId: string;
  data?: {
    /** Specific keys to remove (if empty, clears all) */
    keys?: string[];
    tabIndex?: number;
  };
}

/** Get sessionStorage request */
export interface GetSessionStorageRequest extends BaseRequest {
  type: "getSessionStorage";
  sessionId: string;
  data?: {
    key?: string;
    tabIndex?: number;
  };
}

/** Set sessionStorage request */
export interface SetSessionStorageRequest extends BaseRequest {
  type: "setSessionStorage";
  sessionId: string;
  data: {
    key: string;
    value: string;
    tabIndex?: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Environment emulation
// ═══════════════════════════════════════════════════════════════════════════════

/** Set viewport request */
export interface SetViewportRequest extends BaseRequest {
  type: "setViewport";
  sessionId: string;
  data: {
    width: number;
    height: number;
    tabIndex?: number;
  };
}

/** Set geolocation request */
export interface SetGeolocationRequest extends BaseRequest {
  type: "setGeolocation";
  sessionId: string;
  data: {
    latitude: number;
    longitude: number;
    /** Accuracy in meters (default 100) */
    accuracy?: number;
  };
}

/** Set offline mode request */
export interface SetOfflineRequest extends BaseRequest {
  type: "setOffline";
  sessionId: string;
  data: {
    offline: boolean;
  };
}

/** Emulate media request */
export interface EmulateMediaRequest extends BaseRequest {
  type: "emulateMedia";
  sessionId: string;
  data?: {
    /** Media type: "screen" | "print" | null */
    media?: string;
    /** Color scheme: "light" | "dark" | "no-preference" | null */
    colorScheme?: string;
    /** Reduced motion: "reduce" | "no-preference" | null */
    reducedMotion?: string;
    /** Forced colors: "active" | "none" | null */
    forcedColors?: string;
    tabIndex?: number;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// File upload & dialogs
// ═══════════════════════════════════════════════════════════════════════════════

/** Upload file request */
export interface UploadFileRequest extends BaseRequest {
  type: "uploadFile";
  sessionId: string;
  data: {
    /** Selector for file input element */
    selector: string;
    /** Path(s) to file(s) to upload */
    filePath: string | string[];
    tabIndex?: number;
  };
}

/** Handle dialog request (alert, confirm, prompt) */
export interface HandleDialogRequest extends BaseRequest {
  type: "handleDialog";
  sessionId: string;
  data: {
    /** Whether to accept or dismiss the dialog */
    accept: boolean;
    /** Text to enter for prompt dialogs */
    promptText?: string;
  };
}

/** Get pending dialogs request */
export interface GetDialogsRequest extends BaseRequest {
  type: "getDialogs";
  sessionId: string;
}

/** Get dialogs response */
export interface GetDialogsResponse extends BaseResponse {
  type: "dialogs";
  data: {
    dialogs: Array<{
      type: string;
      message: string;
    }>;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Downloads
// ═══════════════════════════════════════════════════════════════════════════════

/** Get downloads request */
export interface GetDownloadsRequest extends BaseRequest {
  type: "getDownloads";
  sessionId: string;
  data?: {
    /** Clear downloads list after retrieval */
    clear?: boolean;
  };
}

/** Download info */
export interface DownloadInfo {
  path: string;
  suggestedFilename: string;
  url: string;
}

/** Get downloads response */
export interface GetDownloadsResponse extends BaseResponse {
  type: "downloads";
  data: {
    downloads: DownloadInfo[];
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════════════════════════

/** Get state request */
export interface GetStateRequest extends BaseRequest {
  type: "getState";
  sessionId: string;
}

/** Get state response */
export interface GetStateResponse extends BaseResponse {
  type: "state";
  data: {
    url: string;
    title: string;
    sessionId: string;
    createdAt: Date;
    tabs?: TabInfo[];
    stats?: {
      consoleCount: number;
      errorCount: number;
      networkCount: number;
    };
  };
}

/** Captcha detection request */
export interface SolveCaptchaRequest extends BaseRequest {
  type: "solveCaptcha";
  sessionId: string;
}

/** Captcha detection response */
export interface SolveCaptchaResponse extends BaseResponse {
  type: "captchaSolved";
  data: {
    captchaDetected: boolean;
    captchaType: string | null;
    siteKey: string | null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Union types for type-safe message handling
// ═══════════════════════════════════════════════════════════════════════════════

/** All possible request message types */
export type RequestMessage =
  | HealthRequest
  | CreateSessionRequest
  | DestroySessionRequest
  | NavigateRequest
  | GoBackRequest
  | GoForwardRequest
  | RefreshRequest
  | ListTabsRequest
  | CreateTabRequest
  | SwitchTabRequest
  | CloseTabRequest
  | ClickRequest
  | TypeRequest
  | SelectRequest
  | ExtractRequest
  | ObserveRequest
  | QuerySelectorRequest
  | QuerySelectorAllRequest
  | ClickSelectorRequest
  | FillSelectorRequest
  | HoverSelectorRequest
  | WaitForSelectorRequest
  | WaitForUrlRequest
  | WaitForLoadStateRequest
  | WaitForTimeoutRequest
  | EvaluateRequest
  | ScreenshotRequest
  | ExportPdfRequest
  | GetConsoleRequest
  | GetErrorsRequest
  | GetNetworkRequest
  | GetObservabilityStatsRequest
  | GetCookiesRequest
  | SetCookiesRequest
  | ClearCookiesRequest
  | GetLocalStorageRequest
  | SetLocalStorageRequest
  | ClearLocalStorageRequest
  | GetSessionStorageRequest
  | SetSessionStorageRequest
  | SetViewportRequest
  | SetGeolocationRequest
  | SetOfflineRequest
  | EmulateMediaRequest
  | UploadFileRequest
  | HandleDialogRequest
  | GetDialogsRequest
  | GetDownloadsRequest
  | GetStateRequest
  | SolveCaptchaRequest;

/** All possible response message types */
export type ResponseMessage =
  | HealthResponse
  | CreateSessionResponse
  | DestroySessionResponse
  | NavigateResponse
  | ListTabsResponse
  | CreateTabResponse
  | ExtractResponse
  | ObserveResponse
  | QuerySelectorResponse
  | EvaluateResponse
  | ScreenshotResponse
  | ExportPdfResponse
  | GetConsoleResponse
  | GetErrorsResponse
  | GetNetworkResponse
  | GetObservabilityStatsResponse
  | GetCookiesResponse
  | GetLocalStorageResponse
  | GetDialogsResponse
  | GetDownloadsResponse
  | GetStateResponse
  | SolveCaptchaResponse
  | BaseResponse; // Fallback for simple success responses
