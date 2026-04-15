/**
 * Type definitions for plugin-computeruse
 *
 * Ported from coasty-ai/open-computer-use (Apache 2.0)
 * Adapted for elizaOS Service/Action/Provider interfaces.
 */

// ── Desktop Action Types ────────────────────────────────────────────────────

export type DesktopActionType =
  | "screenshot"
  | "click"
  | "double_click"
  | "right_click"
  | "mouse_move"
  | "type"
  | "key"
  | "key_combo"
  | "scroll"
  | "drag";

export interface DesktopActionParams {
  action: DesktopActionType;
  /** [x, y] pixel coordinates for click, double_click, right_click, mouse_move, scroll */
  coordinate?: [number, number];
  /** [x, y] start coordinates for drag */
  startCoordinate?: [number, number];
  /** Text to type (for "type" action) */
  text?: string;
  /** Key name or combo string, e.g. "Return", "ctrl+c" */
  key?: string;
  /** Scroll direction */
  scrollDirection?: "up" | "down" | "left" | "right";
  /** Number of scroll ticks (default: 3) */
  scrollAmount?: number;
}

// ── Browser Action Types ────────────────────────────────────────────────────

export type BrowserActionType =
  | "open"
  | "close"
  | "navigate"
  | "click"
  | "type"
  | "scroll"
  | "screenshot"
  | "dom"
  | "clickables"
  | "execute"
  | "state"
  | "list_tabs"
  | "open_tab"
  | "close_tab"
  | "switch_tab";

export interface BrowserActionParams {
  action: BrowserActionType;
  /** URL for open, navigate, open_tab */
  url?: string;
  /** CSS selector for click, type */
  selector?: string;
  /** [x, y] coordinates for click */
  coordinate?: [number, number];
  /** Text for type action */
  text?: string;
  /** JavaScript code for execute action */
  code?: string;
  /** Scroll direction */
  direction?: "up" | "down";
  /** Scroll amount in pixels */
  amount?: number;
  /** Tab ID for switch_tab, close_tab */
  tabId?: string;
  /** Wait timeout in ms */
  timeout?: number;
}

// ── Window Action Types ─────────────────────────────────────────────────────

export type WindowActionType =
  | "list"
  | "focus"
  | "minimize"
  | "maximize"
  | "close";

export interface WindowActionParams {
  action: WindowActionType;
  /** Window identifier (required for focus, minimize, maximize, close) */
  windowId?: string;
}

// ── Results ─────────────────────────────────────────────────────────────────

export interface ComputerActionResult {
  success: boolean;
  /** Base64-encoded PNG screenshot taken after the action */
  screenshot?: string;
  error?: string;
}

export interface BrowserActionResult {
  success: boolean;
  /** Base64-encoded PNG for screenshot action */
  screenshot?: string;
  /** Text content for dom, state, clickables, execute results */
  content?: string;
  /** Structured data (e.g. tab list, clickable elements) */
  data?: unknown;
  error?: string;
}

export interface WindowActionResult {
  success: boolean;
  /** Window list for "list" action */
  windows?: WindowInfo[];
  error?: string;
}

// ── Shared Types ────────────────────────────────────────────────────────────

export interface WindowInfo {
  id: string;
  title: string;
  app: string;
}

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export interface PlatformCapabilities {
  screenshot: { available: boolean; tool: string };
  computerUse: { available: boolean; tool: string };
  windowList: { available: boolean; tool: string };
  browser: { available: boolean; tool: string };
}

export interface ActionHistoryEntry {
  action: string;
  timestamp: number;
  params?: Record<string, unknown>;
  success: boolean;
}

export interface ComputerUseConfig {
  /** Auto-capture screenshot after each desktop mutation (default: true) */
  screenshotAfterAction: boolean;
  /** Action execution timeout in ms (default: 10000) */
  actionTimeoutMs: number;
  /** Max recent actions to keep for provider context (default: 10) */
  maxRecentActions: number;
}

// ── Browser State Types ─────────────────────────────────────────────────────

export interface BrowserState {
  url: string;
  title: string;
}

export interface ClickableElement {
  tag: string;
  text: string;
  selector: string;
  type?: string;
  href?: string;
  ariaLabel?: string;
}

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}
