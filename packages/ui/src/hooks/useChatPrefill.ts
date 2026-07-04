/**
 * Hook to seed the one floating chat composer from any view — opens the chat
 * (from the pill if collapsed) and loads text for the user to review/send. How a
 * view's empty-state recommendations populate the composer.
 */
import { useCallback } from "react";
import { dispatchChatPrefill } from "../events";

/**
 * Seed the one floating chat composer from any view. Returns `prefill`, which
 * opens the chat (from the pill, if collapsed) and loads `text` into the
 * composer — the user reviews/edits and sends. This is how a view's empty-state
 * recommendations "populate an empty chat": tap a recommendation → the prompt
 * lands in the composer, ready to send.
 *
 * Decoupled from the overlay via {@link dispatchChatPrefill} (CHAT_PREFILL_EVENT)
 * so views stay event-agnostic.
 */
export function useChatPrefill(): {
  prefill: (text: string, select?: boolean) => void;
} {
  const prefill = useCallback((text: string, select = true) => {
    dispatchChatPrefill({ text, select });
  }, []);
  return { prefill };
}
