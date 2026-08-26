/** Defines the app-scoped accessibility state, ephemeral targeting, and action receipt contract. */

export type AppControlPermissionState =
  | "ready"
  | "accessibility_denied"
  | "screen_recording_denied"
  | "helper_unavailable";

export interface AppDescriptor {
  id: string;
  name: string;
  pid: number;
  bundleId?: string;
  path?: string;
  active: boolean;
}

export interface AppElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeAppElement {
  /** Helper-private traversal path. Never expose this as a durable caller id. */
  locator: number[];
  role: string;
  subrole?: string;
  label?: string;
  value?: string;
  description?: string;
  bounds?: AppElementBounds;
  actions: string[];
  enabled: boolean;
  focused: boolean;
  selected?: boolean;
  secure: boolean;
}

export interface AppElement
  extends Omit<NativeAppElement, "locator" | "secure"> {
  /** One-based and valid only for this stateId. */
  element_index: number;
  secure: boolean;
}

export interface NativeAppSnapshot {
  app: AppDescriptor;
  capturedAt: string;
  permission: AppControlPermissionState;
  elements: NativeAppElement[];
  axText: string;
  focusedWindowBounds?: AppElementBounds;
  focusedWindowId?: number;
}

export interface AppStateDiff {
  baseStateId: string;
  added: number[];
  changed: number[];
  removed: number[];
  axTextChanged: boolean;
}

export interface AppState {
  stateId: string;
  app: AppDescriptor;
  capturedAt: string;
  permission: AppControlPermissionState;
  screenshot?: string;
  screenshotMimeType?: "image/png";
  displayId?: number;
  screenshotBounds?: AppElementBounds;
  elements: AppElement[];
  axText: string;
  diff?: AppStateDiff;
  focusedWindowId?: number;
}

export type AppActionKind =
  | "click"
  | "press_key"
  | "type_text"
  | "paste"
  | "scroll"
  | "set_value"
  | "select_text"
  | "secondary_action"
  | "hover_target";

export interface AppActionRequest {
  app: string;
  stateId: string;
  kind: AppActionKind;
  element_index?: number;
  text?: string;
  key?: string;
  modifiers?: string[];
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  format?: "text" | "markdown" | "html";
  secondaryAction?: string;
  /** Canonical policy must explicitly permit the last-resort pointer path. */
  allowPhysicalFallback?: boolean;
  /** Explicit opt-in for the direct-only exact-window experiment. */
  allowExperimentalExactWindow?: boolean;
}

export type AppActionExecutionMode =
  | "semantic_ax"
  | "set_of_marks"
  | "ocr"
  | "guarded_physical"
  | "agent_overlay"
  | "experimental_direct_exact_window";

export interface AppExactWindowDispatchResult {
  success: boolean;
  route: "experimental_direct_exact_window";
  observationId: string;
  targetPid: number;
  targetWindowId: number;
  targetWindowBounds: AppElementBounds;
  pointerBefore: { x: number; y: number };
  pointerAfter: { x: number; y: number };
  error?: string;
}

export interface AppExactWindowPointerDispatcher {
  available(): boolean;
  dispatch(
    input: {
      app: AppDescriptor;
      state: AppState;
      element: NativeAppElement;
      request: AppActionRequest;
      expectedWindowId: number;
    },
    signal?: AbortSignal,
  ): Promise<AppExactWindowDispatchResult>;
}

export interface NativeAppActionResult {
  success: boolean;
  error?: string;
  clipboardRestored?: boolean;
}

export interface AppActionReceipt {
  receiptId: string;
  appId: string;
  kind: AppActionKind;
  beforeStateId: string;
  afterStateId: string;
  executionMode: AppActionExecutionMode;
  element_index?: number;
  completedAt: string;
  /** Whether the requested effect was semantically observed or only posted. */
  effectStatus: "confirmed" | "posted_unconfirmed";
  /** Diagnostic retained when a posted effect cannot be semantically confirmed. */
  effectDiagnostic?: {
    code:
      | "POST_DISPATCH_POINTER_UNAVAILABLE"
      | "POST_DISPATCH_POINTER_CHANGED"
      | "POST_DISPATCH_RECEIPT_UNVERIFIED"
      | "POST_DISPATCH_STATE_UNAVAILABLE"
      | "POST_DISPATCH_TARGET_UNCONFIRMED";
    message: string;
    cause?: string;
  };
  changed: boolean;
  physicalPointerMoved: boolean;
  clipboardRestored?: boolean;
  targetBounds?: AppElementBounds;
}

export interface AppActionOutcome {
  success: boolean;
  error?: string;
  receipt?: AppActionReceipt;
  state?: AppState;
}

export interface AppControlAdapter {
  readonly name: string;
  available(): boolean;
  listApps(signal?: AbortSignal): Promise<AppDescriptor[]>;
  snapshot(app: string, signal?: AbortSignal): Promise<NativeAppSnapshot>;
  perform(
    app: AppDescriptor,
    element: NativeAppElement | undefined,
    request: AppActionRequest,
    signal?: AbortSignal,
  ): Promise<NativeAppActionResult>;
}

export interface VisualGroundingMatch {
  mode: "set_of_marks" | "ocr";
  displayId: number;
  x: number;
  y: number;
}

export interface AppControlGrounder {
  ground(
    state: AppState,
    request: AppActionRequest,
    signal?: AbortSignal,
  ): Promise<VisualGroundingMatch | null>;
}

export interface PhysicalPointerDriver {
  click(x: number, y: number): Promise<void>;
  scroll(
    x: number,
    y: number,
    direction: "up" | "down" | "left" | "right",
    amount: number,
  ): Promise<void>;
}

export interface PhysicalPointerObserver {
  position(): Promise<{ x: number; y: number }>;
}

export interface AppStateCapture {
  capture(
    snapshot: NativeAppSnapshot,
    signal?: AbortSignal,
  ): Promise<{
    screenshot: string;
    displayId: number;
    bounds: AppElementBounds;
  } | null>;
}
