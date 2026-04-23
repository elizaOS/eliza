import type { JSDOM } from "jsdom";

export type BrowserWorkspaceMode = "cloud" | "desktop" | "web";

export type BrowserWorkspaceTabKind = "internal" | "standard";

export type BrowserWorkspaceOperation =
  | "list"
  | "open"
  | "navigate"
  | "show"
  | "hide"
  | "close"
  | "eval"
  | "screenshot";

export type BrowserWorkspaceSubaction =
  | BrowserWorkspaceOperation
  | "back"
  | "batch"
  | "check"
  | "clipboard"
  | "click"
  | "fill"
  | "find"
  | "focus"
  | "forward"
  | "frame"
  | "get"
  | "hover"
  | "inspect"
  | "keydown"
  | "keyup"
  | "keyboardinserttext"
  | "keyboardtype"
  | "console"
  | "cookies"
  | "diff"
  | "dialog"
  | "press"
  | "drag"
  | "errors"
  | "highlight"
  | "mouse"
  | "network"
  | "pdf"
  | "profiler"
  | "reload"
  | "scroll"
  | "scrollinto"
  | "select"
  | "set"
  | "snapshot"
  | "state"
  | "storage"
  | "tab"
  | "trace"
  | "type"
  | "dblclick"
  | "upload"
  | "uncheck"
  | "wait"
  | "window";

export type BrowserWorkspaceGetMode =
  | "attr"
  | "box"
  | "checked"
  | "count"
  | "enabled"
  | "html"
  | "styles"
  | "text"
  | "title"
  | "url"
  | "value"
  | "visible";

export type BrowserWorkspaceFindBy =
  | "alt"
  | "first"
  | "label"
  | "last"
  | "nth"
  | "placeholder"
  | "role"
  | "testid"
  | "text"
  | "title";

export type BrowserWorkspaceFindAction =
  | "check"
  | "click"
  | "fill"
  | "focus"
  | "hover"
  | "text"
  | "type"
  | "uncheck";

export type BrowserWorkspaceWaitState = "hidden" | "visible";

export type BrowserWorkspaceScrollDirection = "down" | "left" | "right" | "up";

export type BrowserWorkspaceClipboardAction =
  | "copy"
  | "paste"
  | "read"
  | "write";

export type BrowserWorkspaceMouseAction = "down" | "move" | "up" | "wheel";

export type BrowserWorkspaceMouseButton = "left" | "middle" | "right";

export type BrowserWorkspaceSetAction =
  | "credentials"
  | "device"
  | "geo"
  | "headers"
  | "media"
  | "offline"
  | "viewport";

export type BrowserWorkspaceCookieAction = "clear" | "get" | "set";

export type BrowserWorkspaceStorageArea = "local" | "session";

export type BrowserWorkspaceStorageAction = "clear" | "get" | "set";

export type BrowserWorkspaceNetworkAction =
  | "harstart"
  | "harstop"
  | "request"
  | "requests"
  | "route"
  | "unroute";

export type BrowserWorkspaceDialogAction = "accept" | "dismiss" | "status";

export type BrowserWorkspaceDiffAction = "screenshot" | "snapshot" | "url";

export type BrowserWorkspaceTraceAction = "start" | "stop";

export type BrowserWorkspaceProfilerAction = "start" | "stop";

export type BrowserWorkspaceStateAction = "load" | "save";

export type BrowserWorkspaceFrameAction = "main" | "select";

export type BrowserWorkspaceTabAction = "close" | "list" | "new" | "switch";

export type BrowserWorkspaceWindowAction = "new";

export type BrowserWorkspaceConsoleAction = "clear" | "list";

export interface BrowserWorkspaceTab {
  id: string;
  title: string;
  url: string;
  partition: string;
  kind?: BrowserWorkspaceTabKind;
  visible: boolean;
  createdAt: string;
  updatedAt: string;
  lastFocusedAt: string | null;
  /** Remote/cloud-managed providers expose a cached live-view image URL. */
  liveViewUrl?: string | null;
  /** Interactive live view (rfb/WebSocket stream) when the provider supports it. */
  interactiveLiveViewUrl?: string | null;
  /** Provider identifier when the tab is backed by a remote browser (e.g. "browserbase"). */
  provider?: string | null;
  /** Provider-specific status string for remote tabs ("starting", "ready", "ended"). */
  status?: string | null;
}

export interface BrowserWorkspaceSnapshot {
  mode: BrowserWorkspaceMode;
  tabs: BrowserWorkspaceTab[];
}

export interface BrowserWorkspaceBridgeConfig {
  baseUrl: string;
  token: string | null;
}

export interface OpenBrowserWorkspaceTabRequest {
  url?: string;
  title?: string;
  show?: boolean;
  partition?: string;
  kind?: BrowserWorkspaceTabKind;
  width?: number;
  height?: number;
}

export interface NavigateBrowserWorkspaceTabRequest {
  id: string;
  url: string;
}

export interface EvaluateBrowserWorkspaceTabRequest {
  id: string;
  script: string;
}

export interface BrowserWorkspaceDomElementSummary {
  ref?: string;
  selector: string;
  tag: string;
  text: string;
  type: string | null;
  name: string | null;
  href: string | null;
  value: string | null;
}

export interface BrowserWorkspaceCommand {
  subaction: BrowserWorkspaceSubaction;
  operation?: BrowserWorkspaceSubaction | "goto" | "read";
  action?: BrowserWorkspaceFindAction;
  baselinePath?: string;
  button?: BrowserWorkspaceMouseButton;
  clipboardAction?: BrowserWorkspaceClipboardAction;
  compact?: boolean;
  consoleAction?: BrowserWorkspaceConsoleAction;
  cookieAction?: BrowserWorkspaceCookieAction;
  deltaX?: number;
  deltaY?: number;
  device?: string;
  dialogAction?: BrowserWorkspaceDialogAction;
  diffAction?: BrowserWorkspaceDiffAction;
  domain?: string;
  id?: string;
  entryKey?: string;
  filePath?: string;
  filter?: string;
  files?: string[];
  frameAction?: BrowserWorkspaceFrameAction;
  fullPage?: boolean;
  headers?: Record<string, string>;
  height?: number;
  url?: string;
  secondaryUrl?: string;
  title?: string;
  script?: string;
  show?: boolean;
  partition?: string;
  selector?: string;
  text?: string;
  value?: string;
  attribute?: string;
  direction?: BrowserWorkspaceScrollDirection;
  exact?: boolean;
  findBy?: BrowserWorkspaceFindBy;
  index?: number;
  key?: string;
  latitude?: number;
  longitude?: number;
  media?: "dark" | "light";
  method?: string;
  mouseAction?: BrowserWorkspaceMouseAction;
  networkAction?: BrowserWorkspaceNetworkAction;
  offline?: boolean;
  outputPath?: string;
  getMode?: BrowserWorkspaceGetMode;
  name?: string;
  pixels?: number;
  profilerAction?: BrowserWorkspaceProfilerAction;
  promptText?: string;
  requestId?: string;
  responseBody?: string;
  responseHeaders?: Record<string, string>;
  responseStatus?: number;
  role?: string;
  scale?: number;
  setAction?: BrowserWorkspaceSetAction;
  state?: BrowserWorkspaceWaitState;
  stateAction?: BrowserWorkspaceStateAction;
  status?: string;
  storageAction?: BrowserWorkspaceStorageAction;
  storageArea?: BrowserWorkspaceStorageArea;
  tabAction?: BrowserWorkspaceTabAction;
  timeoutMs?: number;
  traceAction?: BrowserWorkspaceTraceAction;
  windowAction?: BrowserWorkspaceWindowAction;
  width?: number;
  x?: number;
  y?: number;
  username?: string;
  password?: string;
  ms?: number;
  milliseconds?: number;
  steps?: BrowserWorkspaceCommand[];
}

export interface BrowserWorkspaceCommandResult {
  mode: BrowserWorkspaceMode;
  subaction: BrowserWorkspaceSubaction;
  tab?: BrowserWorkspaceTab;
  tabs?: BrowserWorkspaceTab[];
  closed?: boolean;
  value?: unknown;
  elements?: BrowserWorkspaceDomElementSummary[];
  snapshot?: { data: string };
  steps?: BrowserWorkspaceCommandResult[];
}

export interface BrowserWorkspaceConsoleEntry {
  level: "error" | "info" | "log" | "warn";
  message: string;
  timestamp: string;
}

export interface BrowserWorkspaceErrorEntry {
  message: string;
  stack: string | null;
  timestamp: string;
}

export interface BrowserWorkspaceDialogState {
  defaultValue: string | null;
  message: string;
  open: boolean;
  type: "alert" | "beforeunload" | "confirm" | "prompt";
}

export interface BrowserWorkspaceMouseState {
  buttons: BrowserWorkspaceMouseButton[];
  x: number;
  y: number;
}

export interface BrowserWorkspaceSettingsState {
  credentials: { password: string; username: string } | null;
  device: string | null;
  geo: { latitude: number; longitude: number } | null;
  headers: Record<string, string>;
  media: "dark" | "light" | null;
  offline: boolean;
  viewport: { height: number; scale: number; width: number } | null;
}

export interface BrowserWorkspaceNetworkRoute {
  abort: boolean;
  body: string | null;
  headers: Record<string, string>;
  pattern: string;
  status: number | null;
}

export interface BrowserWorkspaceNetworkRequestRecord {
  id: string;
  matchedRoute: string | null;
  method: string;
  resourceType: string;
  responseBody: string | null;
  responseHeaders: Record<string, string>;
  status: number | null;
  timestamp: string;
  url: string;
}

export interface BrowserWorkspaceTraceRecord {
  active: boolean;
  entries: Array<Record<string, unknown>>;
}

export interface BrowserWorkspaceProfilerRecord {
  active: boolean;
  entries: Array<Record<string, unknown>>;
}

export interface BrowserWorkspaceHarRecord {
  active: boolean;
  entries: BrowserWorkspaceNetworkRequestRecord[];
  startedAt: string | null;
}

export interface BrowserWorkspaceSnapshotRecord {
  bodyText: string;
  title: string;
  url: string;
}

export interface BrowserWorkspaceRuntimeState {
  consoleEntries: BrowserWorkspaceConsoleEntry[];
  currentFrame: string | null;
  dialog: BrowserWorkspaceDialogState | null;
  errors: BrowserWorkspaceErrorEntry[];
  frameDoms: Map<string, JSDOM>;
  highlightedSelector: string | null;
  lastScreenshotData: string | null;
  lastSnapshot: BrowserWorkspaceSnapshotRecord | null;
  mouse: BrowserWorkspaceMouseState;
  networkHar: BrowserWorkspaceHarRecord;
  networkNextRequestId: number;
  networkRequests: BrowserWorkspaceNetworkRequestRecord[];
  networkRoutes: BrowserWorkspaceNetworkRoute[];
  settings: BrowserWorkspaceSettingsState;
  trace: BrowserWorkspaceTraceRecord;
  profiler: BrowserWorkspaceProfilerRecord;
}

export interface WebBrowserWorkspaceTabState extends BrowserWorkspaceTab {
  dom: JSDOM | null;
  history: string[];
  historyIndex: number;
  loadedUrl: string | null;
}
