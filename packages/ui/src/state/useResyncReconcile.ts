/**
 * Live consumer for canonical conversation-resync signals.
 *
 * A reconnect or another transport such as realtime voice can persist messages
 * without going through the mounted chat sender. This hook reloads that active
 * tail so every surface converges on server truth without duplicate local rows.
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
 * messages written outside the mounted sender appear without a manual refresh.
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
    let interruptedVoiceTimer: ReturnType<typeof setTimeout> | null = null;
    const reloadIfActive = (convId: string) => {
      if (activeConversationIdRef.current !== convId) return;
      void loadConversationMessages(convId);
    };
    const onResync = (event: Event) => {
      const detail = (event as CustomEvent<ResyncEventDetail>).detail;
      const convId = detail?.conversationId ?? activeConversationIdRef.current;
      if (!convId) return;
      if (activeConversationIdRef.current !== convId) return;
      if (detail?.reason === "voice-turn-interrupted") {
        // The voice gateway must emit `interrupted` synchronously for fast
        // barge-in, while the aborted canonical stream persists its durable
        // assistant receipt just afterward. A single coalesced trailing reload
        // prevents that reply from appearing only when the next turn starts.
        if (interruptedVoiceTimer !== null) {
          clearTimeout(interruptedVoiceTimer);
        }
        interruptedVoiceTimer = setTimeout(() => {
          interruptedVoiceTimer = null;
          reloadIfActive(convId);
        }, 300);
        return;
      }
      reloadIfActive(convId);
    };
    window.addEventListener(RESYNC_EVENT, onResync);
    return () => {
      window.removeEventListener(RESYNC_EVENT, onResync);
      if (interruptedVoiceTimer !== null) {
        clearTimeout(interruptedVoiceTimer);
      }
    };
    // `activeConversationIdRef` is a stable ref read at event time; re-subscribe
    // only when the loader identity changes.
  }, [activeConversationIdRef, loadConversationMessages]);
}
