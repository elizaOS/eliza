/**
 * Coordinates conversation reset side effects so shell state and chat state
 * clear together.
 */
import * as React from "react";
import { useAppSelectorShallow } from "../../state";

/**
 * Shared "reset the conversation" action.
 *
 * Resets to a fresh greeted thread via the existing `handleNewConversation`
 * path. A non-empty previous conversation is kept (it stays swipe-reachable);
 * only an empty draft we just left is pruned, so resets don't pile up orphan
 * conversations.
 *
 * Used by the main ChatView reset button; the overlay header reset routes
 * through `useShellController.clearConversation`, which calls the same
 * `handleNewConversation` so the behavior is identical everywhere.
 */
export function useConversationReset(): () => void {
  // Granular shallow selector instead of useApp() so this hook only re-renders
  // when the one field it reads changes, not on every app-store field update
  // (#9141 gap 2 — useApp() → useAppSelector migration).
  const { handleNewConversation } = useAppSelectorShallow((s) => ({
    handleNewConversation: s.handleNewConversation,
  }));

  return React.useCallback(() => {
    void handleNewConversation();
  }, [handleNewConversation]);
}
