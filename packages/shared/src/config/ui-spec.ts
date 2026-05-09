/**
 * ui-spec.ts — TypeScript types for the json-render declarative UI spec.
 *
 * A UiSpec describes a tree of UI components that can be rendered
 * from a JSON declaration. This is the full json-render component model.
 *
 * Structure:
 *   { root: "main", elements: { [id]: UiElement }, state: { ... } }
 *
 * Each element has a type, props, optional children (IDs), event bindings,
 * conditional visibility, validation, and repeat/list support.
 */

// ── Dynamic value references ────────────────────────────────────────

/** A value that can be either a literal or a path reference. */
export type DynamicProp<T = string> = T | { $path: string };

/** Conditional expression for dynamic prop resolution. */
export interface CondExpr {
  $cond: {
    eq?: [unknown, unknown];
    neq?: [unknown, unknown];
    gt?: [unknown, unknown];
    lt?: [unknown, unknown];
    gte?: [unknown, unknown];
    lte?: [unknown, unknown];
    truthy?: unknown;
    falsy?: unknown;
    path?: string;
  };
  $then: unknown;
  $else: unknown;
}

// ── Visibility ──────────────────────────────────────────────────────

export type VisibilityOperator = "eq" | "ne" | "gt" | "gte" | "lt" | "lte";

/** Path-based visibility condition. */
export interface PathVisibility {
  path: string;
  operator: VisibilityOperator;
  value: unknown;
}

/** Auth-based visibility condition. */
export interface AuthVisibility {
  auth: "signedIn" | "signedOut" | "admin" | string;
}

/** Logical combinators for complex visibility. */
export interface AndVisibility {
  and: UiSpecVisibilityCondition[];
}
export interface OrVisibility {
  or: UiSpecVisibilityCondition[];
}
export interface NotVisibility {
  not: UiSpecVisibilityCondition;
}

export type UiSpecVisibilityCondition =
  | PathVisibility
  | AuthVisibility
  | AndVisibility
  | OrVisibility
  | NotVisibility;

// ── Validation ──────────────────────────────────────────────────────

/** Built-in validator function names. */
export type BuiltinValidator =
  | "required"
  | "email"
  | "minLength"
  | "maxLength"
  | "pattern"
  | "min"
  | "max";

/** A single validation check on a field. */
export interface UiSpecValidationCheck {
  fn: string;
  args?: Record<string, unknown>;
  message: string;
}

/** Validation configuration for a form element. */
export interface UiSpecValidationConfig {
  checks: UiSpecValidationCheck[];
  validateOn?: "change" | "blur" | "submit";
}

// ── Event binding ───────────────────────────────────────────────────

/** Action success/error handlers. */
export interface ActionOnSuccess {
  action: string;
  params?: Record<string, unknown>;
}

export interface ActionOnError {
  action: string;
  params?: Record<string, unknown>;
}

/** Confirmation prompt before action execution. */
export interface ActionConfirm {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface UiAction {
  action: string;
  params?: Record<string, unknown>;
  confirm?: ActionConfirm;
  onSuccess?: ActionOnSuccess;
  onError?: ActionOnError;
}

export type UiEventBindings = Record<string, UiAction>;

// ── Repeat / list rendering ─────────────────────────────────────────

export interface RepeatConfig {
  path: string;
  key: string;
}

// ── Element types ───────────────────────────────────────────────────

export type UiComponentType =
  // Layout
  | "Stack"
  | "Grid"
  | "Card"
  | "Separator"
  // Typography
  | "Heading"
  | "Text"
  // Form
  | "Input"
  | "Textarea"
  | "Select"
  | "Checkbox"
  | "Radio"
  | "Switch"
  | "Slider"
  | "Toggle"
  | "ToggleGroup"
  | "ButtonGroup"
  // Data
  | "Table"
  | "Carousel"
  | "Badge"
  | "Avatar"
  | "Image"
  // Feedback
  | "Alert"
  | "Progress"
  | "Rating"
  | "Skeleton"
  | "Spinner"
  // Navigation
  | "Button"
  | "Link"
  | "DropdownMenu"
  | "Tabs"
  | "Pagination"
  // Metric
  | "Metric"
  // Visualization
  | "BarGraph"
  | "LineGraph"
  // Interaction
  | "Tooltip"
  | "Popover"
  | "Collapsible"
  | "Accordion"
  | "Dialog"
  | "Drawer";

// ── Element definition ──────────────────────────────────────────────

export interface UiElement {
  type: UiComponentType;
  props: Record<string, unknown>;
  children: string[];
  on?: UiEventBindings;
  repeat?: RepeatConfig;
  visible?: UiSpecVisibilityCondition;
  validation?: UiSpecValidationConfig;
}

// ── Full spec ───────────────────────────────────────────────────────

export interface UiSpec {
  root: string;
  elements: Record<string, UiElement>;
  state: Record<string, unknown>;
}

// ── Auth state (for visibility evaluation) ──────────────────────────

export interface AuthState {
  isSignedIn: boolean;
  roles?: string[];
}

// ── Renderer context (passed through tree) ──────────────────────────

export interface UiRenderContext {
  spec: UiSpec;
  state: Record<string, unknown>;
  setState: (path: string, value: unknown) => void;
  onAction?: (action: string, params?: Record<string, unknown>) => void;
  /** Current repeat item data (set when inside a repeat block). */
  repeatItem?: Record<string, unknown>;
  /** Auth state for visibility evaluation. */
  auth?: AuthState;
  /** Whether the renderer is in a loading/streaming state. */
  loading?: boolean;
  /** Custom validator functions. */
  validators?: Record<
    string,
    (
      value: unknown,
      args?: Record<string, unknown>,
    ) => boolean | Promise<boolean>
  >;
  /** Field validation errors keyed by statePath. */
  fieldErrors?: Record<string, string[]>;
  /** Trigger validation for a field. */
  validateField?: (statePath: string) => void;
}

// ── Streaming types ─────────────────────────────────────────────────

/** RFC 6902 JSON Patch operation. */
export type PatchOp =
  | { op: "add"; path: string; value: unknown }
  | { op: "remove"; path: string }
  | { op: "replace"; path: string; value: unknown }
  | { op: "move"; from: string; path: string }
  | { op: "copy"; from: string; path: string }
  | { op: "test"; path: string; value: unknown };

/** Stream configuration for useUIStream. */
export interface UIStreamConfig {
  api: string;
  onComplete?: (spec: UiSpec) => void;
  onError?: (error: Error) => void;
}
