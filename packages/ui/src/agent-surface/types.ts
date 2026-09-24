/**
 * agent-surface types — the contract that makes every view element addressable,
 * focus-aware, fillable, and reactive to the agent.
 *
 * A view registers its interactive + informational elements through
 * `useAgentElement`. The registry exposes them to the agent via the standard
 * view-interact capabilities (`list-elements`, `agent-fill`, `agent-click`, …)
 * so the floating pill can drive any view from voice or text without the view
 * shipping its own chat surface.
 */

/** Semantic role of an addressable element — drives icons, affordances, search. */
export type AgentElementRole =
  | "button"
  | "link"
  | "text-input"
  | "number-input"
  | "textarea"
  | "select"
  | "toggle"
  | "slider"
  | "tab"
  | "menu-item"
  | "list-item"
  | "card"
  | "metric"
  | "status"
  | "image"
  | "chart"
  | "region"
  | "heading"
  | "custom";

/** Roles the agent can type into. */
export const FILLABLE_ROLES: ReadonlySet<AgentElementRole> =
  new Set<AgentElementRole>([
    "text-input",
    "number-input",
    "textarea",
    "select",
    "slider",
  ]);

/** Roles the agent can activate (click). */
export const CLICKABLE_ROLES: ReadonlySet<AgentElementRole> =
  new Set<AgentElementRole>([
    "button",
    "link",
    "toggle",
    "tab",
    "menu-item",
    "list-item",
    "card",
  ]);

/**
 * Descriptor supplied by a view through `useAgentElement`. The registry keeps a
 * live reference to the DOM node plus these hints so it can act on the element
 * (focus/click/fill) and describe it to the agent.
 */
export interface AgentElementDescriptor {
  /** Stable id unique within the view (e.g. "send.amount", "tab.positions"). */
  id: string;
  /** Semantic role; defaults to "region" when omitted. */
  role?: AgentElementRole;
  /** Human/agent-facing label (what the agent will say to target it). */
  label: string;
  /** Optional grouping key for related elements (e.g. a form or section id). */
  group?: string;
  /** One-line description for the planner / element search. */
  description?: string;
  /** Current status token rendered as `data-state` (e.g. "active", "error"). */
  status?: string;
  /**
   * Marks this element as credential/sensitive data. Sensitive elements remain
   * addressable, but their values are redacted from snapshots and agent fills
   * are rejected.
   */
  sensitive?: boolean;
  /** Sort priority for `list-elements` (lower first). Falls back to DOM order. */
  order?: number;
  /** Override fillability (else derived from role). */
  fillable?: boolean;
  /** Override clickability (else derived from role). */
  clickable?: boolean;
  /** Allowed values for selects / choice pickers. */
  options?: readonly string[];
  /** Current value accessor for controlled components. */
  getValue?: () => unknown;
  /** Controlled fill handler. When present the registry calls it instead of
   *  driving the DOM input directly. */
  onFill?: (value: string) => void;
  /** Controlled activate handler. When present the registry calls it instead of
   *  dispatching a DOM click. */
  onActivate?: () => void;
}

/** Serialisable snapshot of one element, returned to the agent. */
export interface AgentElementSnapshot {
  id: string;
  role: AgentElementRole;
  label: string;
  group?: string;
  description?: string;
  status?: string;
  value?: unknown;
  sensitive?: boolean;
  valueRedacted?: boolean;
  fillable: boolean;
  clickable: boolean;
  focused: boolean;
  visible: boolean;
  options?: readonly string[];
  /** Viewport-relative bounds — lets the agent reason about layout/anchoring. */
  bounds?: { x: number; y: number; width: number; height: number };
}

/** Full snapshot of a view's agent surface. */
export interface AgentSurfaceSnapshot {
  viewId: string;
  viewType: AgentViewType;
  elementCount: number;
  focusedId: string | null;
  elements: AgentElementSnapshot[];
  updatedAt: number;
}

export type AgentViewType = "gui" | "tui" | "xr";

/** Result of an agent action on an element. */
export interface AgentActionResult {
  ok: boolean;
  id?: string;
  reason?: string;
  value?: unknown;
}

// Capability ids handled generically by the agent-surface registry. The
// canonical definition lives in @elizaos/shared so the agent server can dispatch
// against it without importing UI internals (#12408); re-exported here for the
// UI's agent-surface consumers.
export { AGENT_SURFACE_CAPABILITY_IDS } from "@elizaos/shared/views/view-interact-protocol";
