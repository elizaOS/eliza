export type ViewEventPayload = Record<string, unknown>;

export interface ViewEvent {
  /** Namespaced event type, e.g. "wallet:balance:updated". */
  type: string;
  /** ID of the view that emitted the event, or "agent" for server-push. */
  sourceViewId?: string;
  payload: ViewEventPayload;
  timestamp: number;
}

const CHANNEL_NAME = "elizaos-views";
const WINDOW_EVENT_NAME = "elizaos-view-event";

// ---------------------------------------------------------------------------
// BroadcastChannel singleton (lazily created, gracefully absent)
// ---------------------------------------------------------------------------

let _channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
  if (_channel) return _channel;
  if (typeof BroadcastChannel === "undefined") return null;
  try {
    _channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    // error-policy:J4 some environments (SSR, restricted workers) throw on
    // construction; the same-window CustomEvent transport still delivers.
    return null;
  }
  return _channel;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit an event visible to all mounted views in the current window and in
 * other tabs/windows on the same origin.
 */
export function emitViewEvent(
  type: string,
  payload: ViewEventPayload = {},
  sourceViewId?: string,
): void {
  const event: ViewEvent = {
    type,
    payload,
    sourceViewId,
    timestamp: Date.now(),
  };

  // 1. BroadcastChannel — cross-tab delivery.
  getChannel()?.postMessage(event);

  // 2. CustomEvent on window — same-window delivery (also catches the emit
  //    in the same tab when BroadcastChannel is used, since BC does NOT echo
  //    to the sender tab).
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(WINDOW_EVENT_NAME, { detail: event }));
  }
}

/**
 * Subscribe to a specific view event type.
 * Returns an unsubscribe function — call it in a `useEffect` cleanup or
 * when the consumer is destroyed.
 */
export function onViewEvent(
  type: string,
  handler: (event: ViewEvent) => void,
): () => void {
  return onAnyViewEvent((event) => {
    if (event.type === type) handler(event);
  });
}

/**
 * Subscribe to ALL view events. Useful for debugging and middleware.
 * Returns an unsubscribe function.
 */
export function onAnyViewEvent(
  handler: (event: ViewEvent) => void,
): () => void {
  // BroadcastChannel listener — receives events from OTHER tabs/windows.
  const channel = getChannel();
  const bcListener = (msg: MessageEvent<ViewEvent>) => {
    handler(msg.data);
  };
  channel?.addEventListener("message", bcListener);

  // Window CustomEvent listener — receives events from the SAME window
  // (including the sender, since BC does not echo to self).
  const windowListener = (e: Event) => {
    handler((e as CustomEvent<ViewEvent>).detail);
  };
  if (typeof window !== "undefined") {
    window.addEventListener(WINDOW_EVENT_NAME, windowListener);
  }

  return () => {
    channel?.removeEventListener("message", bcListener);
    if (typeof window !== "undefined") {
      window.removeEventListener(WINDOW_EVENT_NAME, windowListener);
    }
  };
}

export const VIEW_EVENTS = {
  /** A wallet balance or token list changed. */
  WALLET_BALANCE_UPDATED: "wallet:balance:updated",
  /** Agent requests the shell to navigate to a view. */
  AGENT_NAVIGATE: "agent:navigate:view",
  /** Ask a specific (or all) view(s) to reload their data. */
  VIEW_REFRESH: "view:refresh",
  /** A view gained focus / became visible. */
  VIEW_FOCUSED: "view:focused",
  /** A view lost focus / became hidden. */
  VIEW_BLURRED: "view:blurred",
  /** A blockchain / payment transaction completed successfully. */
  TRANSACTION_COMPLETE: "transaction:complete",
  /** A user-facing setting was changed and persisted. */
  SETTINGS_CHANGED: "settings:changed",
  /** A plugin was hot-reloaded into the running runtime. */
  PLUGIN_RELOADED: "plugin_reloaded",
} as const;
