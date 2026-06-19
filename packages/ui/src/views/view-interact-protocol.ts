/**
 * View interact protocol — shared types for agent ↔ view interactions.
 *
 * The flow:
 *   1. Agent POSTs to /api/views/:id/interact with a ViewInteractRequest body.
 *   2. Server broadcasts a WS message {type:"view:interact", ...} to all clients.
 *   3. DynamicViewLoader receives the WS message, calls the view module's
 *      interact(capability, params) export (or a standard capability handler).
 *   4. Frontend sends {type:"view:interact:result", ...} back over WS.
 *   5. Server resolves the pending request and returns the result to the agent.
 */

export interface ViewInteractRequest {
  viewId: string;
  capability: string;
  params?: Record<string, unknown>;
  /** UUID generated server-side for correlating the async result. */
  requestId: string;
  /** Timeout in ms before the server gives up waiting. Default 5000. */
  timeoutMs?: number;
}

export interface ViewInteractResult {
  requestId: string;
  success: boolean;
  result?: unknown;
  error?: string;
}

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
} as const;

export type StandardCapability =
  (typeof STANDARD_CAPABILITIES)[keyof typeof STANDARD_CAPABILITIES];
