/**
 * View interact protocol — canonical capability constants shared by
 * `@elizaos/agent` (views-routes) and `@elizaos/ui`.
 *
 * These are the single source of truth for the capability id strings the agent
 * can dispatch against a view. `STANDARD_CAPABILITIES` is the set every view is
 * expected to support; `AGENT_SURFACE_CAPABILITY_IDS` is the set handled
 * generically by the ui agent-surface registry. Both are plain TS built-ins
 * (no React/DOM/@elizaos/core deps) so the module is safe to import from a
 * Node/Bun server boot path.
 *
 * The transport interfaces (`ViewInteractRequest`/`ViewInteractResult`) stay in
 * `@elizaos/ui/views/view-interact-protocol`.
 */

/** Standard capabilities that every view is expected to support. */
export const STANDARD_CAPABILITIES = {
  /** Returns the current view state as JSON. */
  GET_STATE: "get-state",
  /** Forces a data refresh / re-render. */
  REFRESH: "refresh",
  /** Focuses an input or button by CSS selector or name attribute. */
  FOCUS_ELEMENT: "focus-element",
  /** Returns the visible text content of the view container. */
  GET_TEXT: "get-text",
  /** Clicks an element by CSS selector or name attribute. Dispatched generically
   *  by DynamicViewLoader / ShellViewAgentSurface for every loaded view. */
  CLICK_ELEMENT: "click-element",
  /** Sets the value of an input by selector/name. Dispatched generically by
   *  DynamicViewLoader / ShellViewAgentSurface for every loaded view. */
  FILL_INPUT: "fill-input",
} as const;

export type StandardCapability =
  (typeof STANDARD_CAPABILITIES)[keyof typeof STANDARD_CAPABILITIES];

/** Capability ids handled generically by the agent-surface registry. */
export const AGENT_SURFACE_CAPABILITY_IDS: ReadonlySet<string> = new Set([
  "list-elements",
  "describe-element",
  "get-focus",
  "get-agent-state",
  "agent-click",
  "agent-fill",
  "agent-focus",
  "agent-scroll-to",
  "set-highlight",
]);
