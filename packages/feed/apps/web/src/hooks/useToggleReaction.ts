/**
 * useToggleReaction Hook
 *
 * Shared hook for toggling emoji reactions on chat messages.
 * Used by both useChatPage (DMs / group chats) and useTeamChat (team chat).
 *
 * Provides optimistic UI updates, SSE echo suppression, and automatic rollback on failure.
 */

import { useCallback } from 'react';
import { toast } from 'sonner';
import type { MessageReactionSummary } from '@/components/chats/types';
import { useAuth } from '@/hooks/useAuth';
import { useAuthStore } from '@/stores/authStore';
import type { ChatMessage } from './useChatMessages';

/**
 * Compute the next reactions array after a local user toggles an emoji.
 * Exported so SSE handlers in useChatMessages can reuse the same logic.
 */
export function applyReactionDelta(
  existing: MessageReactionSummary[] | undefined,
  emoji: string,
  action: 'added' | 'removed',
  isMine: boolean
): MessageReactionSummary[] {
  const map = new Map<string, MessageReactionSummary>();
  for (const r of existing ?? []) map.set(r.emoji, { ...r });

  const prev = map.get(emoji);
  const prevCount = prev?.count ?? 0;
  const nextCount =
    action === 'added' ? prevCount + 1 : Math.max(0, prevCount - 1);

  if (nextCount <= 0) {
    map.delete(emoji);
  } else {
    map.set(emoji, {
      emoji,
      count: nextCount,
      reactedByMe: isMine ? action === 'added' : (prev?.reactedByMe ?? false),
    });
  }

  const out = [...map.values()];
  out.sort((a, b) => b.count - a.count);
  return out;
}

interface UseToggleReactionOptions {
  chatId: string | null;
  messages: ChatMessage[];
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  markPendingReactionDelta: (delta: {
    messageId: string;
    emoji: string;
    action: 'added' | 'removed';
  }) => void;
}

/**
 * Returns a stable `toggleReaction(messageId, emoji, currentlyReactedByMe)` callback.
 */
export function useToggleReaction({
  chatId,
  messages,
  updateMessage,
  markPendingReactionDelta,
}: UseToggleReactionOptions) {
  const { user } = useAuthStore();
  const { getAccessToken } = useAuth();

  const toggleReaction = useCallback(
    async (messageId: string, emoji: string, currentlyReactedByMe: boolean) => {
      if (!chatId || !user) return;

      const token = await getAccessToken();
      if (!token) return;

      const existing = messages.find((m) => m.id === messageId);
      const prevReactions = existing?.reactions;

      const action: 'added' | 'removed' = currentlyReactedByMe
        ? 'removed'
        : 'added';

      // Optimistic update + SSE echo suppression
      markPendingReactionDelta({ messageId, emoji, action });
      updateMessage(messageId, {
        reactions: applyReactionDelta(prevReactions, emoji, action, true),
      });

      const url = currentlyReactedByMe
        ? `/api/chats/${chatId}/messages/${messageId}/reactions?emoji=${encodeURIComponent(emoji)}`
        : `/api/chats/${chatId}/messages/${messageId}/reactions`;

      const response = await fetch(url, {
        method: currentlyReactedByMe ? 'DELETE' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: currentlyReactedByMe ? undefined : JSON.stringify({ emoji }),
      });

      if (!response.ok) {
        // Rollback optimistic update
        updateMessage(messageId, { reactions: prevReactions });
        toast.error('Failed to update reaction');
        return;
      }

      const data = await response.json();
      if (Array.isArray(data.reactions)) {
        updateMessage(messageId, { reactions: data.reactions });
      }
    },
    [
      chatId,
      user,
      getAccessToken,
      messages,
      updateMessage,
      markPendingReactionDelta,
    ]
  );

  return toggleReaction;
}
