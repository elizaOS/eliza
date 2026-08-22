/**
 * Non-component values split out of AppContext.tsx so the Provider component
 * file is not the home for runtime constants. Imported back into AppContext.tsx
 * for use inside AppProvider.
 */

/**
 * Requests a canonical conversation-tail reload after another transport writes
 * messages outside the mounted chat sender. WebSocket recovery and realtime
 * voice both use this boundary so the UI reconciles server truth instead of
 * inventing a second optimistic transcript.
 */
export const RESYNC_EVENT = "elizaos:needs-resync";

export interface ResyncEventDetail {
  conversationId: string | null;
  reason?:
    | "connection-recovered"
    | "voice-turn-progress"
    | "voice-turn-complete"
    | "voice-turn-interrupted";
}

/** Notify the mounted app that canonical conversation history changed elsewhere. */
export function dispatchConversationResync(detail: ResyncEventDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<ResyncEventDetail>(RESYNC_EVENT, { detail }),
  );
}
