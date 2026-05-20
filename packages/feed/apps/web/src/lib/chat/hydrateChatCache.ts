/**
 * Hydrates the React Query cache from IndexedDB on app startup.
 *
 * Called once during QueryClient initialization in Providers.tsx.
 * Seeds the 10 most recently accessed chats into the query cache so
 * opening any of them renders instantly (no spinner, no fetch).
 *
 * Data is marked stale immediately so React Query revalidates in the
 * background — the user sees cached messages instantly while fresh
 * data loads silently.
 */

import type { QueryClient } from '@tanstack/react-query';
import type { ChatMessagesData } from '@/hooks/useChatMessages';
import { chatMessagesQueryKey } from '@/hooks/useChatMessages';
import { getCachedChatIds, getCachedMessages } from './message-store';

const HYDRATION_CHAT_LIMIT = 10;

export async function hydrateChatCacheFromIndexedDB(
  queryClient: QueryClient,
  userId: string
): Promise<void> {
  // IndexedDB is only available in the browser — skip during SSR
  if (typeof window === 'undefined') return;

  const chatIds = await getCachedChatIds(userId, HYDRATION_CHAT_LIMIT);
  if (chatIds.length === 0) return;

  await Promise.all(
    chatIds.map(async (chatId) => {
      const cached = await getCachedMessages(userId, chatId);
      if (!cached || cached.messages.length === 0) return;

      const data: ChatMessagesData = {
        messages: cached.messages,
        hasMore: cached.hasMore,
        nextCursor: cached.nextCursor,
      };

      // Set data in cache (user-scoped key)
      queryClient.setQueryData(chatMessagesQueryKey(chatId, userId), data);

      // Mark stale so next access triggers background revalidation.
      // refetchType: 'none' means don't trigger a fetch right now —
      // just mark the data as needing a refresh when it's next accessed.
      queryClient.invalidateQueries({
        queryKey: chatMessagesQueryKey(chatId, userId),
        refetchType: 'none',
      });
    })
  );
}
