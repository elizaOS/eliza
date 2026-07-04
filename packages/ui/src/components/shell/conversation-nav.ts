/**
 * Pure adjacent-conversation resolution for the chat overlay's horizontal swipe.
 * The list is most-recent-first, so "prev" is the newer neighbor and "next" the
 * older; useShellController wraps these into the `ConversationNav` the overlay
 * consumes. No React, no state — just index math over the conversation list.
 */
import type { Conversation } from "../../api/client-types-chat";

/** Adjacent-conversation navigation for the overlay's horizontal swipe. */
export interface ConversationNav {
  /** A newer conversation exists to swipe toward. */
  hasPrev: boolean;
  /** An older conversation exists to swipe toward. */
  hasNext: boolean;
  /** Select the newer (previous) conversation. */
  goPrev: () => void;
  /** Select the older (next) conversation. */
  goNext: () => void;
  /** The active conversation's id, or null when none is selected/known. */
  activeId: string | null;
  /** The active conversation's position in the most-recent-first list, or -1
   *  when it isn't in the list (new/not-found). Surfaced on the chat-sheet DOM so
   *  flows like the tutorial can observe a switch/new-chat without reaching into
   *  controller internals. */
  index: number;
}

export type ConversationNavDirection = "prev" | "next";

export function resolveAdjacentConversationId(
  conversations: readonly Pick<Conversation, "id">[] | null | undefined,
  activeConversationId: string | null | undefined,
  direction: ConversationNavDirection,
): string | null {
  const list = Array.isArray(conversations) ? conversations : [];
  const index = list.findIndex((c) => c.id === activeConversationId);
  const targetIndex = direction === "prev" ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= list.length) {
    return null;
  }
  return list[targetIndex]?.id ?? null;
}

/**
 * Pure adjacent-conversation navigation for the overlay's horizontal swipe
 * (#8929). The list is most-recent-first, so "prev" moves toward the newer
 * (lower index) conversation and "next" toward the older (higher index) one.
 * `hasPrev`/`hasNext` drive the swipe edge hints; `goPrev`/`goNext` select the
 * adjacent conversation by id. When the active conversation isn't in the list
 * (not-found), neither direction is navigable. Extracted as a pure function so
 * the index-walk is unit-testable without rendering the AppContext-bound hook.
 *
 * Invariant: a new conversation PREPENDS at index 0 and becomes active, so right
 * after creating one the index-0 swipe toward a newer chat (`goPrev`) is a
 * boundary no-op (`hasPrev` is false). The conversation-swipe interleaving e2e
 * (`run-conversation-swipe-e2e.mjs`) drives + asserts exactly this against the
 * real overlay.
 */
export function buildConversationNav(
  conversations: readonly Pick<Conversation, "id">[] | null | undefined,
  activeConversationId: string | null | undefined,
  onSelect: (id: string) => void,
): ConversationNav {
  const list = Array.isArray(conversations) ? conversations : [];
  const index = list.findIndex((c) => c.id === activeConversationId);
  const hasPrev = index > 0;
  const hasNext = index >= 0 && index < list.length - 1;
  const prevId = resolveAdjacentConversationId(
    list,
    activeConversationId,
    "prev",
  );
  const nextId = resolveAdjacentConversationId(
    list,
    activeConversationId,
    "next",
  );
  return {
    hasPrev,
    hasNext,
    goPrev: () => {
      if (prevId) onSelect(prevId);
    },
    goNext: () => {
      if (nextId) onSelect(nextId);
    },
    activeId: activeConversationId ?? null,
    index,
  };
}
