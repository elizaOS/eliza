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
  focusedWindowId?: number;
  focusedWindowBounds?: AppElementBounds;
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
  focusedWindowId?: number;
  elements: AppElement[];
  axText: string;
  diff?: AppStateDiff;
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
  /** Explicitly selects the disabled-by-default direct-only experimental route. */
  allowExperimentalExactWindow?: boolean;
}

export type AppActionExecutionMode =
  | "semantic_ax"
  | "process_pid_keyboard_cgevent"
  | "experimental_direct_exact_window"
  | "guarded_physical"
  | "agent_overlay";

export interface AppPointerPosition {
  x: number;
  y: number;
}

export interface PhysicalFallbackApprovalReceipt {
  approvalId: string;
  requestedAt: string;
  approvedAt: string;
  mode: string;
}

export interface PhysicalFallbackApprovalRequest {
  appId: string;
  kind: "click" | "scroll";
  element_index: number;
  groundingMode: "set_of_marks" | "ocr" | "element_bounds";
  target: AppPointerPosition;
}

export interface ExperimentalExactWindowApprovalReceipt {
  approvalId: string;
  requestedAt: string;
  approvedAt: string;
  mode: string;
}

export interface ExperimentalExactWindowApprovalRequest {
  appId: string;
  kind: "click" | "scroll";
  element_index: number;
  observationId: string;
  targetPid: number;
  targetWindowId: number;
  windowBounds: AppElementBounds;
  targetBounds: AppElementBounds;
}

export interface NativeAppActionResult {
  success: boolean;
  targetPid: number;
  targetWindowId: number;
  error?: string;
  clipboardRestored?: boolean;
  executionMode?:
    | "semantic_ax"
    | "process_pid_keyboard_cgevent"
    | "experimental_direct_exact_window";
}

export interface AppExactWindowDispatchResult {
  success: boolean;
  route: "experimental_direct_exact_window";
  observationId: string;
  targetPid: number;
  targetWindowId: number;
  targetWindowBounds: AppElementBounds;
  pointerBefore: AppPointerPosition;
  pointerAfter: AppPointerPosition;
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

export interface AppActionReceipt {
  receiptId: string;
  appId: string;
  kind: AppActionKind;
  beforeStateId: string;
  afterStateId: string;
  targetPid: number;
  targetWindowId: number;
  executionMode: AppActionExecutionMode;
  element_index?: number;
  completedAt: string;
  changed: boolean;
  /** True only when Eliza invoked the global physical input driver. */
  physicalPointerInput: boolean;
  /** Coordinate comparison; movement without input is external or unknown. */
  physicalPointerMoved: boolean;
  pointerObservation: "unchanged" | "changed" | "unavailable";
  pointerBefore?: AppPointerPosition;
  pointerAfter?: AppPointerPosition;
  groundingMode?: "set_of_marks" | "ocr" | "element_bounds";
  physicalFallbackApproval?: PhysicalFallbackApprovalReceipt;
  experimentalExactWindowApproval?: ExperimentalExactWindowApprovalReceipt;
  clipboardRestored?: boolean;
  targetWindowBounds?: AppElementBounds;
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
    expectedWindowId: number,
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

export interface AppPointerObserver {
  getPosition(): Promise<AppPointerPosition>;
}

export type PhysicalFallbackAuthorizer = (
  request: PhysicalFallbackApprovalRequest,
  signal?: AbortSignal,
) => Promise<PhysicalFallbackApprovalReceipt>;

export type ExperimentalExactWindowAuthorizer = (
  request: ExperimentalExactWindowApprovalRequest,
  signal?: AbortSignal,
) => Promise<ExperimentalExactWindowApprovalReceipt>;

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
