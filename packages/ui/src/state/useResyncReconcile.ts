/**
 * Live consumer for the WebSocket-reconnect resync signal.
 *
 * `AppContext` dispatches {@link RESYNC_EVENT} on `client.onReconnect` after a
 * dropped socket comes back; this hook is its listener and performs the
 * reconcile. Without it, messages the agent emitted while the socket was down
 * stay hidden until a manual refresh.
 */

import { type MutableRefObject, useEffect } from "react";
import { RESYNC_EVENT, type ResyncEventDetail } from "./AppContext.hooks";
import type { LoadConversationMessagesResult } from "./internal";

export interface UseResyncReconcileDeps {
  /** Stable ref whose `.current` is the conversation the user is viewing. */
  activeConversationIdRef: MutableRefObject<string | null>;
  /** Full-replace reload of a conversation's messages from the server. */
  loadConversationMessages: (
    convId: string,
  ) => Promise<LoadConversationMessagesResult>;
}

/**
 * On {@link RESYNC_EVENT}, reload the affected conversation from the server so
 * messages missed during a WebSocket gap appear without a manual refresh.
 *
 * Only the conversation the user is currently viewing is force-reloaded here; a
 * background conversation is reconciled the next time it is opened (its normal
 * load already fetches the latest server state). The resync can also arrive
 * after the user navigated away, so the active-id guard drops a reload targeting
 * a conversation that is no longer on screen.
 */
export function useResyncReconcile({
  activeConversationIdRef,
  loadConversationMessages,
}: UseResyncReconcileDeps): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onResync = (event: Event) => {
      const detail = (event as CustomEvent<ResyncEventDetail>).detail;
      const convId = detail?.conversationId ?? activeConversationIdRef.current;
      if (!convId) return;
      if (activeConversationIdRef.current !== convId) return;
      void loadConversationMessages(convId);
    };
    window.addEventListener(RESYNC_EVENT, onResync);
    return () => window.removeEventListener(RESYNC_EVENT, onResync);
    // `activeConversationIdRef` is a stable ref read at event time; re-subscribe
    // only when the loader identity changes.
  }, [activeConversationIdRef, loadConversationMessages]);
}
