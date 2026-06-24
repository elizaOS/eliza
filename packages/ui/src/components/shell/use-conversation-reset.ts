import * as React from "react";
import { useAppSelectorShallow } from "../../state";
import { requestConversationResetUndo } from "./conversation-undo-store";

/**
 * Shared "reset the conversation, with soft-undo" action (#8929/#8930).
 *
 * Resets to a fresh greeted thread via the existing `handleNewConversation`
 * path, then surfaces the glassmorphic undo toast so the previous conversation
 * can be restored with one tap/swipe. A non-empty previous conversation is kept
 * by `handleNewConversation` (only empty drafts are pruned), so undo is simply a
 * re-select; restoring auto-cleans the throwaway fresh thread.
 *
 * Used by the main ChatView reset button; the overlay header reset routes
 * through `useShellController.clearConversation`, which calls the same
 * `requestConversationResetUndo` so the affordance is identical everywhere.
 */
export function useConversationReset(): () => void {
  // Granular shallow selector instead of useApp() so this hook only re-renders
  // when one of the four fields it actually reads changes, not on every
  // app-store field update (#9141 gap 2 — useApp() → useAppSelector migration).
  const {
    handleNewConversation,
    handleSelectConversation,
    activeConversationId,
    t,
  } = useAppSelectorShallow((s) => ({
    handleNewConversation: s.handleNewConversation,
    handleSelectConversation: s.handleSelectConversation,
    activeConversationId: s.activeConversationId,
    t: s.t,
  }));

  return React.useCallback(() => {
    const previousConversationId = activeConversationId;
    void handleNewConversation();
    requestConversationResetUndo({
      previousConversationId,
      restore: (id) => {
        void handleSelectConversation(id);
      },
      translate: typeof t === "function" ? (key) => t(key) : undefined,
    });
  }, [
    activeConversationId,
    handleNewConversation,
    handleSelectConversation,
    t,
  ]);
}
