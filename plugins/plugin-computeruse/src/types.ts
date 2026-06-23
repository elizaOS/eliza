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
  | "middle_click"
  | "mouse_down"
  | "mouse_up"
  | "type"
  | "key"
  | "key_combo"
  | "key_down"
  | "key_up"
  | "scroll"
  | "drag"
  | "get_cursor_position"
  | "detect_elements"
  | "ocr"
  | "open"
  | "launch"
  | "kill_app"
  | "set_value";

export interface DesktopActionParams {
  action: DesktopActionType;
  coordinate?: [number, number];
  startCoordinate?: [number, number];
  /**
   * Multi-point polyline for `drag` (≥2 points, local to `displayId`). When
   * present it supersedes `startCoordinate`/`coordinate` and traces every
   * waypoint with the button held (curves, corners, marquee, swipe paths).
   */
  path?: Array<[number, number]>;
  /**
   * Display the coordinate is local to. Required for any coordinate-bearing
   * action (click, mouse_move, drag, scroll, key_combo, click_with_modifiers).
   * If omitted, the service falls back to the primary display and emits a
   * deprecation warning. New callers MUST set this.
   */
  displayId?: number;
  /** Coordinate space of `coordinate`/`startCoordinate`: logical (default) or backing-store pixels (macOS retina captures). */
  coordSource?: "logical" | "backing";
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
  /** Target file / URL / folder for the `open` action. */
  target?: string;
  /** Application name or executable path for the `launch` action. */
  app?: string;
  /** Arguments passed to the launched application (`launch`). */
  appArgs?: string[];
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
  | "close"
  | "get_current_window_id"
  | "get_application_windows"
  | "set_bounds"
  | "get_window_size"
  | "get_window_position";

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
  /** Coordinates for move / set_bounds action */
  x?: number;
  y?: number;
  /** Window size for set_bounds action */
  width?: number;
  height?: number;
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
  /** Display the screenshot belongs to (when known). */
  displayId?: number;
  /** Current cursor position (for the `get_cursor_position` action). */
  cursorPosition?: { x: number; y: number };
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
  /** Window list for "list" / "get_application_windows" actions */
  windows?: WindowInfo[];
  count?: number;
  /** Focused window id for "get_current_window_id" (null when none focused). */
  windowId?: string | null;
  /** Focused window descriptor for "get_current_window_id". */
  window?: WindowInfo | null;
  /** Window bounds for "get_window_size" / "get_window_position". */
  bounds?: ScreenRegion;
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
  | "list_downloads"
  | "read_bytes"
  | "write_bytes"
  | "create_dir"
  | "directory_exists"
  | "get_file_size";

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
  /** Base64 payload for write_bytes. */
  base64?: string;
  /** Byte window for read_bytes (chunked binary transfer). */
  offset?: number;
  length?: number;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory";
  path: string;
}

export interface FileActionResult extends ComputerUseResult {
  path?: string;
  content?: string;
  /** Base64-encoded bytes for read_bytes. */
  bytes?: string;
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

/**
 * One physical display attached to the host. Surfaced to the agent via the
 * `computerState` provider so the planner knows the layout before issuing
 * coordinate-bearing actions.
 */
export interface DisplayDescriptor {
  id: number;
  /** [x, y, width, height] in OS-global pixel space. */
  bounds: [number, number, number, number];
  /** Backing-store scale factor (1 on Linux/Windows, >1 on HiDPI macOS). */
  scaleFactor: number;
  primary: boolean;
  name: string;
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
  clipboard: { available: boolean; tool: string };
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
  /** Execution mode: 'yolo' runs CUA ops on the host, 'sandbox' delegates to a VM/container backend. */
  mode: ComputerUseMode;
  /** Sandbox configuration; only consulted when `mode === 'sandbox'`. */
  sandbox?: SandboxConfig;
}

// ── Mode + Sandbox ────────────────────────────────────────────────────────

/**
 * Top-level execution mode. Picked exactly once at plugin init by reading
 * `ELIZA_COMPUTERUSE_MODE`. There is no per-call override.
 *
 * - `yolo`    — operate the host machine (existing behaviour).
 * - `sandbox` — operate an isolated VM/container; the host is never touched.
 */
export type ComputerUseMode = "yolo" | "sandbox";

/** Implemented sandbox backend identifier. */
export type SandboxBackendName = "docker" | "wsb" | "qemu";

export interface SandboxConfig {
  backend: SandboxBackendName;
  /**
   * Container/VM image identifier. Operator must pull or build this image
   * themselves; the plugin does not ship one. Default: `cua/linux:latest`.
   */
  image: string;
  /** Optional overrides forwarded to the backend (env, mounts, args). */
  options?: SandboxBackendOptions;
}

export interface SandboxBackendOptions {
  /** Extra environment variables exposed inside the sandbox. */
  env?: Record<string, string>;
  /** Host:container path mount pairs (Docker only). */
  mounts?: Array<{ host: string; container: string; readOnly?: boolean }>;
  /** Resource limits passed through to the backend. */
  resources?: { cpus?: number; memoryMb?: number };
  /**
   * Remote-guest RPC endpoint for the VM backends (WSB / QEMU, #9170 M13). The
   * in-guest computer-server listens here; the host POSTs
   * `{command, params}` → `{success, result}`. Defaults to
   * `http://127.0.0.1:<rpcPort>/cua`.
   */
  rpcUrl?: string;
  /** Host-forwarded guest RPC port (WSB / QEMU). Default 8000. */
  rpcPort?: number;
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
