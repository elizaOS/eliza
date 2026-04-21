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
  text?: string;
  key?: string;
  modifiers?: string[];
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
  direction?: "up" | "down";
  amount?: number;
  tabId?: string;
  tab_index?: string | number;
  index?: string | number;
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
  windowTitle?: string;
  window?: string;
  title?: string;
  arrangement?: string;
  x?: number;
  y?: number;
}

// ── File Actions ──────────────────────────────────────────────────────────

export type FileActionType =
  | "read"
  | "write"
  | "edit"
  | "append"
  | "delete"
  | "exists"
  | "list"
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
  encoding?: BufferEncoding | string;
  oldText?: string;
  newText?: string;
  old_text?: string;
  new_text?: string;
  find?: string;
  replace?: string;
}

// ── Terminal Actions ──────────────────────────────────────────────────────

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
  timeout?: number;
  timeoutSeconds?: number;
  sessionId?: string;
  session_id?: string;
  cwd?: string;
  text?: string;
}

// ── Shared Results ────────────────────────────────────────────────────────

export interface BaseActionResult {
  success: boolean;
  error?: string;
  message?: string;
  approvalRequired?: boolean;
  approvalId?: string;
  permissionDenied?: boolean;
  permissionType?: PermissionType;
}

export interface ComputerActionResult extends BaseActionResult {
  screenshot?: string;
  data?: unknown;
}

export interface BrowserActionResult extends BaseActionResult {
  screenshot?: string;
  frontendScreenshot?: string;
  content?: string;
  data?: unknown;
  url?: string;
  title?: string;
  isOpen?: boolean;
  is_open?: boolean;
  tabs?: BrowserTab[];
  elements?: ClickableElement[];
  count?: number;
}

export interface WindowActionResult extends BaseActionResult {
  windows?: WindowInfo[];
  count?: number;
}

export interface FileActionResult extends BaseActionResult {
  path?: string;
  content?: string;
  exists?: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
  is_file?: boolean;
  is_directory?: boolean;
  size?: number;
  items?: FileEntry[];
  count?: number;
}

export interface TerminalActionResult extends BaseActionResult {
  output?: string;
  exitCode?: number;
  exit_code?: number;
  sessionId?: string;
  session_id?: string;
  cwd?: string;
}

export type ComputerUseResult =
  | ComputerActionResult
  | BrowserActionResult
  | WindowActionResult
  | FileActionResult
  | TerminalActionResult;

// ── Shared Models ─────────────────────────────────────────────────────────

export interface WindowInfo {
  id: string;
  title: string;
  app: string;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory";
  path: string;
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
  screenshot: PlatformCapability;
  computerUse: PlatformCapability;
  windowList: PlatformCapability;
  browser: PlatformCapability;
  terminal: PlatformCapability;
  fileSystem: PlatformCapability;
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
  /** Human approval mode for local computer actions */
  approvalMode: ApprovalMode;
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
  screenshotAfterAction: boolean;
  actionTimeoutMs: number;
  maxRecentActions: number;
  approvalMode: ApprovalMode;
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
