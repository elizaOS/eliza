/**
 * Type definitions for plugin-computeruse.
 *
 * Ported from coasty-ai/open-computer-use (Apache 2.0) and adapted for the
 * elizaOS service/action/provider model.
 */

export type PermissionType =
  | "accessibility"
  | "screen_recording"
  | "microphone"
  | "camera"
  | "shell";

// ── Desktop Actions ───────────────────────────────────────────────────────

export type DesktopActionType =
  | "screenshot"
  | "click"
  | "click_with_modifiers"
  | "double_click"
  | "right_click"
  | "mouse_move"
  | "type"
  | "key"
  | "key_combo"
  | "scroll"
  | "drag"
  | "detect_elements"
  | "ocr";

export interface DesktopActionParams {
  action: DesktopActionType;
  coordinate?: [number, number];
  startCoordinate?: [number, number];
  /** Modifier keys to hold during click_with_modifiers */
  modifiers?: string[];
  /** Text to type (for "type" action) */
  text?: string;
  key?: string;
  hold_keys?: string[];
  button?: "left" | "middle" | "right";
  clicks?: number;
  scrollDirection?: "up" | "down" | "left" | "right";
  scrollAmount?: number;
  amount?: number;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

// ── Browser Actions ───────────────────────────────────────────────────────

export type BrowserActionType =
  | "open"
  | "connect"
  | "close"
  | "navigate"
  | "click"
  | "type"
  | "scroll"
  | "screenshot"
  | "dom"
  | "get_dom"
  | "clickables"
  | "get_clickables"
  | "execute"
  | "state"
  | "info"
  | "context"
  | "get_context"
  | "wait"
  | "list_tabs"
  | "open_tab"
  | "close_tab"
  | "switch_tab";

export interface BrowserActionParams {
  action: BrowserActionType;
  url?: string;
  selector?: string;
  coordinate?: [number, number];
  text?: string;
  code?: string;
  /** Text to wait for or click by text content */
  waitForText?: string;
  /** Text to wait to disappear */
  waitForTextGone?: string;
  /** Scroll direction */
  direction?: "up" | "down";
  amount?: number;
  tabId?: string;
  /** Numeric tab index alias from upstream callers */
  index?: number;
  /** Snake-case alias for tab index */
  tab_index?: number;
  /** Wait timeout in ms */
  timeout?: number;
}

// ── Window Actions ────────────────────────────────────────────────────────

export type WindowActionType =
  | "list"
  | "focus"
  | "switch"
  | "arrange"
  | "move"
  | "minimize"
  | "maximize"
  | "restore"
  | "close";

export interface WindowActionParams {
  action: WindowActionType;
  windowId?: string;
  /** Window title match for switch action */
  windowTitle?: string;
  /** App name match for switch action */
  appName?: string;
  /** Upstream title alias */
  title?: string;
  /** Upstream window alias */
  window?: string;
  /** Layout hint for arrange action */
  arrangement?: string;
  /** Coordinates for move action */
  x?: number;
  y?: number;
}

// ── File Actions ──────────────────────────────────────────────────────────

export interface ComputerUseResult {
  success: boolean;
  message?: string;
  error?: string;
  permissionDenied?: boolean;
  permissionType?: PermissionType;
  approvalRequired?: boolean;
  approvalId?: string;
}

export interface ComputerActionResult extends ComputerUseResult {
  /** Base64-encoded PNG screenshot taken after the action */
  screenshot?: string;
  /** Structured data payload (e.g. OCR/detect results) */
  data?: unknown;
}

export interface BrowserActionResult extends ComputerUseResult {
  /** Base64-encoded PNG for screenshot action */
  screenshot?: string;
  /** Front-end proxy screenshot variant */
  frontendScreenshot?: string;
  /** Text content for dom, state, clickables, execute results */
  content?: string;
  /** Structured data (e.g. tab list, clickable elements) */
  data?: unknown;
  url?: string;
  title?: string;
  isOpen?: boolean;
  is_open?: boolean;
  tabs?: BrowserTab[];
  elements?: ClickableElement[];
  count?: number;
}

export interface WindowActionResult extends ComputerUseResult {
  /** Window list for "list" action */
  windows?: WindowInfo[];
  count?: number;
}

export type FileActionType =
  | "read"
  | "write"
  | "edit"
  | "append"
  | "delete"
  | "exists"
  | "list"
  | "list_directory"
  | "delete_directory"
  | "upload"
  | "download"
  | "list_downloads";

export interface FileActionParams {
  action: FileActionType;
  path?: string;
  filepath?: string;
  dirpath?: string;
  content?: string;
  oldText?: string;
  newText?: string;
  old_text?: string;
  new_text?: string;
  find?: string;
  replace?: string;
  encoding?: BufferEncoding;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory";
  path: string;
}

export interface FileActionResult extends ComputerUseResult {
  path?: string;
  content?: string;
  exists?: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
  is_file?: boolean;
  is_directory?: boolean;
  size?: number;
  count?: number;
  items?: FileEntry[];
}

export type TerminalActionType =
  | "connect"
  | "execute"
  | "read"
  | "type"
  | "clear"
  | "close"
  | "execute_command";

export interface TerminalActionParams {
  action: TerminalActionType;
  command?: string;
  cwd?: string;
  timeout?: number;
  timeoutSeconds?: number;
  sessionId?: string;
  session_id?: string;
  text?: string;
}

export interface TerminalActionResult extends ComputerUseResult {
  sessionId?: string;
  session_id?: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  exit_code?: number;
}

// ── Shared Models ─────────────────────────────────────────────────────────

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

export interface PlatformCapability {
  available: boolean;
  tool: string;
}

export interface PlatformCapabilities {
  screenshot: { available: boolean; tool: string };
  computerUse: { available: boolean; tool: string };
  windowList: { available: boolean; tool: string };
  browser: { available: boolean; tool: string };
  terminal: { available: boolean; tool: string };
  fileSystem: { available: boolean; tool: string };
}

export interface ActionHistoryEntry {
  action: string;
  timestamp: number;
  params?: Record<string, unknown>;
  success: boolean;
}

export type ApprovalMode =
  | "full_control"
  | "smart_approve"
  | "approve_all"
  | "off";

export interface PendingApproval {
  id: string;
  command: string;
  parameters: Record<string, unknown>;
  requestedAt: string;
}

export interface ApprovalSnapshot {
  mode: ApprovalMode;
  pendingCount: number;
  pendingApprovals: PendingApproval[];
}

export interface ApprovalResolution {
  id: string;
  command: string;
  approved: boolean;
  cancelled: boolean;
  mode: ApprovalMode;
  requestedAt: string;
  resolvedAt: string;
  reason?: string;
}

export interface ComputerUseConfig {
  /** Auto-capture screenshot after each desktop mutation (default: true) */
  screenshotAfterAction: boolean;
  /** Action execution timeout in ms (default: 10000) */
  actionTimeoutMs: number;
  /** Max recent actions to keep for provider context (default: 10) */
  maxRecentActions: number;
  /** Approval mode for side-effecting commands */
  approvalMode: ApprovalMode;
  /** Launch puppeteer-core in headless mode (default: false) */
  browserHeadless?: boolean;
}

// ── Browser Models ────────────────────────────────────────────────────────

export interface BrowserState {
  url: string;
  title: string;
  isOpen?: boolean;
  is_open?: boolean;
}

export interface BrowserInfo extends BrowserState {
  success: boolean;
  error?: string;
  userAgent?: string;
  viewport?: { width: number; height: number } | null;
  tabs?: number;
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
