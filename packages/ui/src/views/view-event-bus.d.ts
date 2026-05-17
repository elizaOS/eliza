/**
 * view-event-bus.ts
 *
 * Cross-view pub-sub bus. Lets mounted views signal state changes to each
 * other and lets the agent push updates into views.
 *
 * Transport stack (both fire on every emit):
 *  1. BroadcastChannel("elizaos-views") — reaches other tabs / windows on
 *     the same origin when the API is available.
 *  2. window.dispatchEvent(CustomEvent) — reaches same-window listeners
 *     synchronously.
 *
 * No React, no heavy libraries. Tree-shakeable by design.
 */
export type ViewEventPayload = Record<string, unknown>;
export interface ViewEvent {
  /** Namespaced event type, e.g. "wallet:balance:updated". */
  type: string;
  /** ID of the view that emitted the event, or "agent" for server-push. */
  sourceViewId?: string;
  payload: ViewEventPayload;
  timestamp: number;
}
/**
 * Emit an event visible to all mounted views in the current window and in
 * other tabs/windows on the same origin.
 */
export declare function emitViewEvent(
  type: string,
  payload?: ViewEventPayload,
  sourceViewId?: string,
): void;
/**
 * Subscribe to a specific view event type.
 * Returns an unsubscribe function — call it in a `useEffect` cleanup or
 * when the consumer is destroyed.
 */
export declare function onViewEvent(
  type: string,
  handler: (event: ViewEvent) => void,
): () => void;
/**
 * Subscribe to ALL view events. Useful for debugging and middleware.
 * Returns an unsubscribe function.
 */
export declare function onAnyViewEvent(
  handler: (event: ViewEvent) => void,
): () => void;
//# sourceMappingURL=view-event-bus.d.ts.map
