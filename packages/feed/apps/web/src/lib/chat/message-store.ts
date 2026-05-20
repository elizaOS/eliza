/**
 * IndexedDB persistence layer for chat messages.
 *
 * Stores the most recent messages per chat so conversations load instantly
 * on page refresh or return visit. Uses idb-keyval for a simple key/value
 * interface over IndexedDB.
 *
 * Storage limits:
 * - 100 most recent messages per chat (~30 KB per chat)
 * - 50 most recently accessed chats (LRU eviction)
 * - Total: ~1.5 MB — well within IndexedDB quotas
 */

import { del, get, set } from "idb-keyval";
import type { ChatMessage, ChatMessagesData } from "@/hooks/useChatMessages";

const MAX_CACHED_MESSAGES_PER_CHAT = 100;
const MAX_CACHED_CHATS = 50;

interface CachedChatMessages {
  chatId: string;
  messages: ChatMessage[];
  hasMore: boolean;
  nextCursor: string | null;
  cachedAt: number;
}

const isBrowser = typeof window !== "undefined";

/** User-scoped key helpers — isolate cached data per authenticated user. */
function storeKey(userId: string, chatId: string): string {
  return `chat-msgs:${userId}:${chatId}`;
}
function indexKey(userId: string): string {
  return `chat-msgs-index:${userId}`;
}

export async function getCachedMessages(
  userId: string,
  chatId: string,
): Promise<CachedChatMessages | null> {
  if (!isBrowser) return null;
  const cached = await get<CachedChatMessages>(storeKey(userId, chatId));
  return cached ?? null;
}

export async function setCachedMessages(
  userId: string,
  chatId: string,
  data: ChatMessagesData,
): Promise<void> {
  if (!isBrowser) return;
  const trimmed: CachedChatMessages = {
    chatId,
    messages: data.messages.slice(-MAX_CACHED_MESSAGES_PER_CHAT),
    hasMore: data.hasMore,
    nextCursor: data.nextCursor,
    cachedAt: Date.now(),
  };
  await set(storeKey(userId, chatId), trimmed);

  // Update LRU index and evict old chats if over limit.
  // Multi-tab note: concurrent writes are last-write-wins on the index key.
  // This is acceptable — per-chat data keys survive regardless, and the index
  // is only used for startup hydration and eviction.
  const idx = indexKey(userId);
  const index = (await get<string[]>(idx)) ?? [];
  const updated = [chatId, ...index.filter((id) => id !== chatId)];
  if (updated.length > MAX_CACHED_CHATS) {
    const evicted = updated.splice(MAX_CACHED_CHATS);
    await Promise.all(evicted.map((id) => del(storeKey(userId, id))));
  }
  await set(idx, updated);
}

/**
 * Returns the chat IDs stored in IndexedDB (most recent first), capped at `limit`.
 */
export async function getCachedChatIds(
  userId: string,
  limit = 10,
): Promise<string[]> {
  if (!isBrowser) return [];
  const index = await get<string[]>(indexKey(userId));
  if (!index) return [];
  return index.slice(0, limit);
}

/**
 * Clears all IndexedDB chat cache for a specific user.
 * Called on logout to prevent data leaking to the next session.
 */
export async function clearUserChatCache(userId: string): Promise<void> {
  if (!isBrowser) return;
  const idx = indexKey(userId);
  const index = (await get<string[]>(idx)) ?? [];
  await Promise.all(index.map((id) => del(storeKey(userId, id))));
  await del(idx);
}
