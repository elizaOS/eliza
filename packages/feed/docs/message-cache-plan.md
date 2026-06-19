# Message Cache Plan — Client-Side Persistence

**Date:** 2026-04-02
**Goal:** Cache messages locally in the browser so conversations load instantly on revisit, eliminating the full-fetch-from-API pattern that currently shows a loading spinner every time a user opens or switches chats.

---

## Current State

### How Messages Work Today

```
User opens chat → spinner → GET /api/chats/{id}?limit=50 → render messages
User switches to another chat → clear all messages → spinner → full fetch again
User switches back → clear again → spinner → same 50 messages re-fetched
```

**Frontend state:** `useChatMessages` hook (`apps/web/src/hooks/useChatMessages.ts`)
- Messages stored in `useState<ChatMessage[]>([])` — React component state only
- On chat switch: `setMessages([])` then full refetch (line 482-484)
- `hasLoadedRef` tracks loaded chats, but is cleared on switch (line 478-479)
- No persistent storage — messages vanish on navigation, tab close, or chat switch

**Real-time updates:** SSE via `useSSEChannel` pushes `new_message` and `message_reaction` events. This works well for live conversations but doesn't help with initial load.

**Polling fallback:** 15s interval re-fetches latest 50 messages (lines 496-591). This means the API serves the same 50 messages every 15 seconds even when nothing has changed.

### The UX Problem

1. **Every chat switch = full spinner + 50-message fetch.** Open Chat A, switch to Chat B, switch back to Chat A = three full API round-trips. Chat A's messages were in memory 2 seconds ago but got discarded.

2. **Page refresh / tab close = total amnesia.** Close the tab, reopen → every conversation starts from scratch. No local persistence at all.

3. **Polling re-fetches unchanged data.** The 15s polling interval fetches the same 50 messages repeatedly even when the conversation is idle. Pure waste when SSE is working.

4. **Conversation list refetches on every mount.** `loadChats()` in `useChatPage` (line 107) fetches the full chat list from the API on every page load.

### What React Query Already Provides

React Query (`@tanstack/react-query` v5.90.8) is already installed (`apps/web/package.json:75`). The leaderboard plan (WI-L1) uses it for client caching. We should use the same pattern here, plus IndexedDB for cross-session persistence.

---

## Plan

### Architecture

```
                    ┌─────────────────────────┐
                    │     React Component      │
                    │   useChatMessages hook   │
                    └────────┬────────────────┘
                             │ reads from
                    ┌────────▼────────────────┐
                    │     React Query Cache    │
                    │  (in-memory, per-chat)   │
                    │  staleTime: 2 min        │
                    │  gcTime: 30 min          │
                    └────────┬────────────────┘
                             │ hydrates from / persists to
                    ┌────────▼────────────────┐
                    │      IndexedDB           │
                    │  (idb-keyval or Dexie)   │
                    │  per-chat message store  │
                    │  survives tab close      │
                    └────────┬────────────────┘
                             │ revalidates against
                    ┌────────▼────────────────┐
                    │     API + SSE            │
                    │  GET /api/chats/{id}     │
                    │  SSE new_message events  │
                    └─────────────────────────┘
```

**Flow on chat open:**
1. Check React Query cache → if fresh, render instantly (no fetch)
2. If stale or missing, check IndexedDB → render cached messages immediately (no spinner)
3. Fetch latest from API in background → merge new messages into cache
4. SSE pushes live messages → appended to cache in real-time

**Key insight:** Messages are append-only (new messages always have newer IDs/timestamps). We never need to re-fetch old messages — we only need to fetch messages newer than our last cached message.

---

### WI-M1: React Query for In-Memory Chat Message Caching

**Priority:** P0 — eliminates spinner on chat switch
**Files:** `apps/web/src/hooks/useChatMessages.ts`

#### Problem

`useChatMessages` uses raw `useState`. Switching chats clears messages and refetches. No deduplication, no background revalidation, no caching.

#### Solution

Wrap the message fetch in React Query. Keep the SSE subscription and optimistic updates intact — React Query handles the fetch/cache layer, SSE handles the live append layer.

**Key design decision:** The query key is `['chat-messages', chatId]`. Messages are fetched via the existing API. SSE updates are applied via `queryClient.setQueryData()` to mutate the cache directly.

**Required prerequisite:** `replaceOptimisticMessage` (line 119) and `isMatchingOptimistic` (line 92) are currently **private functions** inside `useChatMessages.ts` — not exported. They must be exported (or extracted to a shared utility like `apps/web/src/hooks/chatMessageUtils.ts`) so they can be used in the `queryClient.setQueryData` callbacks. The function signatures and logic stay identical; only the export visibility changes.

**Global default note:** The app-wide QueryClient (`Providers.tsx:233`) sets `staleTime: 60_000` (1 min) and `refetchOnWindowFocus: false`. The per-query `staleTime` below overrides this for messages specifically.

```typescript
// apps/web/src/hooks/useChatMessages.ts — new approach

import { useQuery, useQueryClient } from '@tanstack/react-query';

const MESSAGES_STALE_TIME = 2 * 60 * 1000;  // 2 min — overrides global 1 min default
const MESSAGES_GC_TIME = 30 * 60 * 1000;    // 30 min — keep old chats in memory

interface ChatMessagesData {
  messages: ChatMessage[];
  hasMore: boolean;
  nextCursor: string | null;
}

// The query fetches initial messages from the API
const query = useQuery<ChatMessagesData>({
  queryKey: ['chat-messages', chatId],
  queryFn: async ({ signal }) => {
    const token = await getSafeAccessToken();
    const response = await fetch(
      `/api/chats/${chatId}?limit=${CHAT_PAGE_SIZE}`,
      { headers: { Authorization: `Bearer ${token}` }, signal }
    );
    const data = await response.json();
    const formatted = (data.messages as RawApiMessage[]).map((msg) =>
      formatMessage(msg, chatId!)
    );
    return {
      messages: formatted,
      hasMore: data.pagination?.hasMore ?? false,
      nextCursor: data.pagination?.nextCursor ?? null,
    };
  },
  enabled: !!chatId,
  staleTime: MESSAGES_STALE_TIME,
  gcTime: MESSAGES_GC_TIME,
  // Show previous chat's data while loading new chat (prevents flash)
  placeholderData: (prev) => prev,
});
```

**SSE updates mutate the query cache directly:**
```typescript
const queryClient = useQueryClient();

function handleNewMessage(newMessage: ChatMessage) {
  queryClient.setQueryData<ChatMessagesData>(
    ['chat-messages', chatId],
    (old) => {
      if (!old) return old;
      // Dedup / replace optimistic
      const updatedMessages = replaceOptimisticMessage(old.messages, newMessage);
      return { ...old, messages: updatedMessages };
    }
  );
}
```

**Optimistic messages also mutate the cache:**
```typescript
function addOptimisticMessage(message: ChatMessage) {
  queryClient.setQueryData<ChatMessagesData>(
    ['chat-messages', chatId],
    (old) => {
      if (!old) return { messages: [message], hasMore: false, nextCursor: null };
      return { ...old, messages: [...old.messages, message] };
    }
  );
}
```

#### What Changes

| Aspect | Before | After |
|--------|--------|-------|
| Chat switch | Clear + refetch + spinner | Instant from React Query cache |
| Back to previous chat | Full refetch | Instant (gcTime: 30 min) |
| SSE new message | `setMessages(prev => ...)` | `queryClient.setQueryData(...)` |
| Optimistic message | `setMessages(prev => [...prev, msg])` | `queryClient.setQueryData(...)` |
| Polling fallback | Every 15s regardless | React Query `refetchInterval` only when stale |
| Load more (pagination) | Separate `loadMore` state | Stays as imperative fetch, prepends to cache |

#### What Stays the Same

- `useSSEChannel` subscription — untouched
- Optimistic message matching logic (`replaceOptimisticMessage`) — untouched, just exported
- Reaction delta handling — untouched, just targets queryClient.setQueryData instead
- Message formatting (`formatMessage`) — untouched

#### Dual Fetch Problem

Currently, `useChatPage.loadChatDetails()` (line 171) AND `useChatMessages.loadMessages()` (line 256) BOTH call `GET /api/chats/{id}` for the same chat — a wasteful duplicate fetch. With React Query, this resolves naturally:

- `useChatMessages` owns the React Query cache for `['chat-messages', chatId]`
- `useChatPage.loadChatDetails()` should be refactored to **read messages from the React Query cache** instead of fetching them separately. It still needs to fetch `chat` metadata and `participants`, but the messages come from the shared cache.

Concretely, in `useChatPage.ts` line 178-183, replace:
```typescript
setChatDetails({ ...data, chat: data.chat, messages: data.messages, participants: data.participants });
```
with:
```typescript
setChatDetails({ ...data, chat: data.chat, messages: [], participants: data.participants });
// messages are managed by useChatMessages via React Query — don't duplicate
```

The sync effect at lines 552-559 that copies `realtimeMessages` into `chatDetails` already handles this — it overwrites `chatDetails.messages` with the realtime messages from `useChatMessages`. So removing the initial `data.messages` population is safe.

#### Load More (Pagination)

`loadMore` prepends older messages to the list. With React Query, this becomes:

```typescript
const loadMore = useCallback(async () => {
  const currentData = queryClient.getQueryData<ChatMessagesData>(['chat-messages', chatId]);
  if (!chatId || !currentData?.nextCursor || isLoadingMore) return;

  setIsLoadingMore(true);
  const token = await getSafeAccessToken();
  const response = await fetch(
    `/api/chats/${chatId}?cursor=${currentData.nextCursor}&limit=${CHAT_PAGE_SIZE}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await response.json();
  const formatted = (data.messages as RawApiMessage[]).map((msg) => formatMessage(msg, chatId));

  queryClient.setQueryData<ChatMessagesData>(['chat-messages', chatId], (old) => {
    if (!old) return old;
    return {
      messages: [...formatted, ...old.messages], // prepend older messages
      hasMore: data.pagination?.hasMore ?? false,
      nextCursor: data.pagination?.nextCursor ?? null,
    };
  });
  setIsLoadingMore(false);
}, [chatId, isLoadingMore, getSafeAccessToken, queryClient]);
```

This atomically updates messages + pagination state in a single `setQueryData` call. `isLoadingMore` remains a local `useState` since it's a transient UI concern, not cached data.

#### Polling Simplification

The 15s polling interval (lines 496-591) can be replaced with React Query's `refetchInterval`:

```typescript
refetchInterval: isConnected ? false : 15_000, // Only poll when SSE is disconnected
```

When SSE is connected, live updates come through the channel. When SSE drops, React Query polls. This eliminates the manual `setInterval` + cleanup logic.

---

### WI-M2: IndexedDB Persistence for Cross-Session Cache

**Priority:** P1 — eliminates spinner on page refresh / return visit
**Files:** New file `apps/web/src/lib/chat/message-store.ts`, modify `useChatMessages.ts`

#### Problem

React Query's in-memory cache doesn't survive page refresh or tab close. Users who close and reopen the app still see spinners for every conversation.

#### Solution

Use IndexedDB to persist the latest messages per chat. On chat open, hydrate React Query from IndexedDB (instant render), then revalidate from API in background.

**Library:** `idb-keyval` — 600 bytes gzipped, zero dependencies, simple get/set/del API over IndexedDB.

**Verified: NOT currently installed.** Must be added:
```bash
cd apps/web && bun add idb-keyval
```

```typescript
// apps/web/src/lib/chat/message-store.ts

import { get, set, del } from 'idb-keyval';

const MAX_CACHED_MESSAGES_PER_CHAT = 100; // Keep last 100 messages per chat
const MAX_CACHED_CHATS = 50;              // Limit total stored chats

interface CachedChatMessages {
  chatId: string;
  messages: ChatMessage[];
  hasMore: boolean;
  nextCursor: string | null;
  cachedAt: number; // timestamp for LRU eviction
}

const STORE_KEY_PREFIX = 'chat-msgs:';
const INDEX_KEY = 'chat-msgs-index'; // tracks which chats are cached

export async function getCachedMessages(
  chatId: string
): Promise<CachedChatMessages | null> {
  const cached = await get<CachedChatMessages>(`${STORE_KEY_PREFIX}${chatId}`);
  return cached ?? null;
}

export async function setCachedMessages(
  chatId: string,
  data: CachedChatMessages
): Promise<void> {
  // Trim to max messages
  const trimmed = {
    ...data,
    messages: data.messages.slice(-MAX_CACHED_MESSAGES_PER_CHAT),
    cachedAt: Date.now(),
  };
  await set(`${STORE_KEY_PREFIX}${chatId}`, trimmed);

  // Update index and evict old chats if over limit
  const index = (await get<string[]>(INDEX_KEY)) ?? [];
  const updated = [chatId, ...index.filter((id) => id !== chatId)];
  if (updated.length > MAX_CACHED_CHATS) {
    const evicted = updated.splice(MAX_CACHED_CHATS);
    await Promise.all(evicted.map((id) => del(`${STORE_KEY_PREFIX}${id}`)));
  }
  await set(INDEX_KEY, updated);
}

export async function appendCachedMessages(
  chatId: string,
  newMessages: ChatMessage[]
): Promise<void> {
  const existing = await getCachedMessages(chatId);
  if (!existing) return;

  const existingIds = new Set(existing.messages.map((m) => m.id));
  const deduped = newMessages.filter((m) => !existingIds.has(m.id));
  if (deduped.length === 0) return;

  await setCachedMessages(chatId, {
    ...existing,
    messages: [...existing.messages, ...deduped],
  });
}
```

#### Integration with React Query

**Timing constraint:** React Query's `initialData` is read synchronously on first render. IndexedDB is async. Using `useState` + `useEffect` to set `initialData` would cause: render 1 (no data, spinner) → render 2 (IndexedDB data) → render 3 (API data). This defeats the "instant render" goal.

**Solution:** Seed the React Query cache from IndexedDB BEFORE the component mounts, using a top-level prefetch. This happens once on app init, not per-chat.

```typescript
// apps/web/src/lib/chat/hydrateChatCache.ts
// Called once during app startup (e.g., in Providers.tsx or a layout effect)

import { QueryClient } from '@tanstack/react-query';
import { getCachedMessages } from './message-store';
import { get } from 'idb-keyval';

const INDEX_KEY = 'chat-msgs-index';

export async function hydrateChatCacheFromIndexedDB(queryClient: QueryClient) {
  const index = await get<string[]>(INDEX_KEY);
  if (!index || index.length === 0) return;

  // Hydrate the 10 most recent chats (don't block startup with all 50)
  const recentChatIds = index.slice(0, 10);
  await Promise.all(
    recentChatIds.map(async (chatId) => {
      const cached = await getCachedMessages(chatId);
      if (!cached) return;
      queryClient.setQueryData(['chat-messages', chatId], {
        messages: cached.messages,
        hasMore: cached.hasMore,
        nextCursor: cached.nextCursor,
      });
      // Mark as stale so React Query revalidates in background
      queryClient.invalidateQueries({
        queryKey: ['chat-messages', chatId],
        refetchType: 'none', // don't trigger refetch, just mark stale
      });
    })
  );
}
```

Call during app init:
```typescript
// In Providers.tsx, after QueryClient creation:
const [queryClient] = useState(() => {
  const client = new QueryClient({ /* ... */ });
  // Fire-and-forget — doesn't block render
  void hydrateChatCacheFromIndexedDB(client);
  return client;
});
```

Now when `useChatMessages` renders for a previously-visited chat, React Query already has data in its cache (from IndexedDB hydration). The component renders instantly with cached messages, then revalidates in background.

**Persist to IndexedDB on data changes:**

```typescript
// In useChatMessages, after the useQuery:
useEffect(() => {
  if (chatId && query.data && query.data.messages.length > 0) {
    // Fire-and-forget — don't block renders
    void setCachedMessages(chatId, {
      chatId,
      ...query.data,
      cachedAt: Date.now(),
    });
  }
}, [chatId, query.data]);
```

#### UX Flow

```
1. User opens Chat A:
   → IndexedDB has 80 cached messages from last session
   → Render immediately (no spinner)
   → React Query fetches latest 50 from API in background
   → Merge: keep cached history + append any new messages
   → User sees seamless conversation with no loading state

2. User closes tab, reopens next day:
   → Same flow — IndexedDB still has the messages
   → API fetch brings in messages since last visit
   → Old messages are already rendered, new ones appear at bottom
```

#### Eviction

- **Per-chat limit:** 100 most recent messages per chat (older ones available via pagination from API)
- **Total chats limit:** 50 most recently accessed chats (LRU eviction via index key)
- **No expiry:** Messages don't expire — they're always valid historical data. Freshness is handled by the API revalidation layer, not by discarding old data.

**Multi-tab note:** The LRU index is a single `idb-keyval` key (`chat-msgs-index`). If two tabs write simultaneously, last-write-wins may lose an entry from the index. This is acceptable — the per-chat data keys still exist in IndexedDB and would be found on next direct access. The index is only used for startup hydration (WI-M2) and eviction. Worst case: a chat gets evicted slightly early or a stale entry lingers. Not worth the complexity of IndexedDB transactions for this edge case.

---

### WI-M3: Incremental Sync Instead of Full Refetch

**Priority:** P1 — eliminates redundant data transfer
**Files:** `apps/web/src/hooks/useChatMessages.ts`, `apps/web/src/app/api/chats/[id]/route.ts`

#### Problem

Every refetch (polling, stale revalidation, chat reopen) fetches the latest 50 messages from scratch. If the conversation has 200 messages cached locally and 3 new messages arrived, we still fetch 50 and diff client-side. The polling fallback (every 15s) is especially wasteful.

#### Solution: `after` Parameter (New API Code Path)

Add an `after` query parameter to `GET /api/chats/{id}` that returns only messages created after the given ISO timestamp. This is a **separate code path** from the existing cursor pagination — `cursor` fetches older messages (DESC, `lt`), while `after` fetches newer messages (ASC, `gt`).

**Validated:** The current cursor pagination works by looking up a message ID, getting its `createdAt`, then filtering `lt(messages.createdAt, cursorMessage.createdAt)` with `DESC` ordering (lines 192-227 of `route.ts`). The `after` parameter is the inverse — it filters `gt(messages.createdAt, sinceDate)` with `ASC` ordering and does NOT use the `limit+1` pagination trick (since we want ALL new messages, not a paginated window).

**API change** (`apps/web/src/app/api/chats/[id]/route.ts`):

```typescript
// New query parameter alongside existing cursor/limit (around line 105)
const after = searchParams.get('after'); // ISO timestamp

// New code path — MUTUALLY EXCLUSIVE with cursor pagination
if (after) {
  const afterDate = new Date(after);
  // Validate the date
  if (isNaN(afterDate.getTime())) {
    return NextResponse.json({ error: 'Invalid after timestamp' }, { status: 400 });
  }

  // Fetch messages AFTER the given timestamp, ordered ASC (oldest first)
  // Cap at limit to prevent unbounded result sets
  messagesList = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        gt(messages.createdAt, afterDate)
      )
    )
    .orderBy(asc(messages.createdAt))
    .limit(effectiveLimit);

  // No pagination trick needed — we want all new messages up to limit
  hasMore = false; // caller should re-fetch if they got exactly `limit` results
  nextCursor = null;

  // Response includes a flag so the client knows this is a sync response
  // and should APPEND rather than REPLACE
} else if (cursor) {
  // ... existing cursor pagination code unchanged ...
}
```

The response shape stays identical — `{ chat, messages, participants, pagination }`. The client differentiates sync responses by checking whether it passed `after` in the request, not by a response flag. This is simpler and doesn't require API schema changes.

**Frontend change — separate sync function, NOT inside queryFn:**

The React Query `queryFn` always does a full fetch (for initial load and stale revalidation). A separate `syncNewMessages` function handles incremental sync. This avoids the complexity of a queryFn that behaves differently depending on cache state.

```typescript
// Called by refetchInterval callback or SSE reconnect
async function syncNewMessages(chatId: string) {
  const currentData = queryClient.getQueryData<ChatMessagesData>(['chat-messages', chatId]);
  const lastMessage = currentData?.messages?.at(-1);
  if (!lastMessage) return; // no cache = do a full refetch instead

  const token = await getSafeAccessToken();
  const response = await fetch(
    `/api/chats/${chatId}?after=${encodeURIComponent(lastMessage.createdAt)}&limit=${CHAT_PAGE_SIZE}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) return;

  const data = await response.json();
  const newMessages = (data.messages as RawApiMessage[]).map((msg) =>
    formatMessage(msg, chatId)
  );

  if (newMessages.length === 0) return; // nothing new

  queryClient.setQueryData<ChatMessagesData>(['chat-messages', chatId], (old) => {
    if (!old) return old;
    // Dedup: skip any messages already in cache
    const existingIds = new Set(old.messages.map((m) => m.id));
    const deduped = newMessages.filter((m) => !existingIds.has(m.id));
    if (deduped.length === 0) return old;
    return { ...old, messages: [...old.messages, ...deduped] };
  });
}
```

Replace the 15s polling `setInterval` with a call to `syncNewMessages`:
```typescript
// Only when SSE is disconnected
useEffect(() => {
  if (isConnected || !chatId) return;
  const interval = setInterval(() => syncNewMessages(chatId), 15_000);
  return () => clearInterval(interval);
}, [isConnected, chatId]);
```

**Impact:**
- Polling: Instead of 50 messages every 15s, fetches 0-2 new messages (typically empty when SSE is working)
- Revalidation: Background refresh after staleTime sends only delta
- Bandwidth: ~95% reduction in data transferred for idle conversations

---

### WI-M4: Cache Conversation List

**Priority:** P2 — instant inbox load
**Files:** `apps/web/src/components/chats/hooks/useChatPage.ts`

#### Problem

`loadChats()` in `useChatPage` (line 107) fetches the full chat list from `/api/chats` on every mount. This shows a spinner every time the user navigates to the chat page.

#### Solution

Wrap `loadChats` in React Query with client-side caching.

```typescript
import { useQuery, useQueryClient } from '@tanstack/react-query';

const chatListQuery = useQuery({
  queryKey: ['chat-list'],
  queryFn: async () => {
    const token = await getAccessToken();
    const response = await fetch('/api/chats', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    return [
      ...(data.groupChats || []),
      ...(data.directChats || []),
    ].sort((a, b) => {
      const aTime = a.lastMessage?.createdAt || a.updatedAt;
      const bTime = b.lastMessage?.createdAt || b.updatedAt;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });
  },
  staleTime: 30_000,  // 30s — chat list changes when new messages arrive
  gcTime: 10 * 60_000, // 10 min
  refetchOnWindowFocus: true,
});
```

**SSE-driven chat list updates (limited scope):**

**Constraint:** The current SSE architecture subscribes to individual chat channels (`chat:${chatId}`), not a global "all my chats" channel. The user only receives SSE events for the chat they're currently viewing. This means SSE cannot update the chat list for messages arriving in OTHER chats.

**What we CAN do:** When a `new_message` SSE event arrives for the currently-viewed chat, update the chat list optimistically:

```typescript
// In the SSE handler for the current chat:
queryClient.setQueryData<Chat[]>(['chat-list'], (old) => {
  if (!old) return old;
  return old
    .map((chat) =>
      chat.id === incomingMessage.chatId
        ? { ...chat, lastMessage: { content: incomingMessage.content, createdAt: incomingMessage.createdAt, senderId: incomingMessage.senderId } }
        : chat
    )
    .sort((a, b) => {
      const aTime = a.lastMessage?.createdAt || a.updatedAt;
      const bTime = b.lastMessage?.createdAt || b.updatedAt;
      return new Date(bTime).getTime() - new Date(aTime).getTime();
    });
});
```

For messages in OTHER chats (not currently viewed), the chat list refreshes via React Query's staleTime (30s) or `refetchOnWindowFocus`. This is acceptable — the chat list is a low-frequency concern.

**Future improvement (out of scope):** Subscribe to a global `user:${userId}` SSE channel that broadcasts notification-level events (new message in any chat, unread count changes). This would enable real-time chat list reordering for all chats, not just the active one.

---

### WI-M5: Smart Polling — Only When SSE Is Down

**Priority:** P2 — reduces unnecessary API calls
**Files:** `apps/web/src/hooks/useChatMessages.ts`

#### Problem

The current 15s polling interval (lines 496-591) runs unconditionally, even when SSE is delivering messages in real-time. This is pure redundancy when SSE is healthy.

#### Solution

Already addressed in WI-M1's React Query integration:

```typescript
refetchInterval: isConnected ? false : 15_000,
```

When SSE is connected (`isConnected` from `useSSEChannel`), disable polling entirely. When SSE drops, React Query's `refetchInterval` kicks in as fallback.

**Additional refinement:** When SSE reconnects after a gap, do a single `since`-based sync (WI-M3) to catch any messages missed during the disconnect:

```typescript
// In useSSEChannel reconnect handler:
useEffect(() => {
  if (isConnected && chatId) {
    // SSE just reconnected — sync any missed messages
    queryClient.invalidateQueries({ queryKey: ['chat-messages', chatId] });
  }
}, [isConnected, chatId]);
```

---

## Implementation Order

```
Phase 1 (Core — eliminates chat-switch spinners):
  WI-M1: React Query for in-memory message caching
    ↓
Phase 2 (Persistence + Efficiency):
  WI-M2: IndexedDB for cross-session persistence  ← parallel
  WI-M3: Incremental sync (since parameter)       ← parallel
    ↓
Phase 3 (Polish):
  WI-M4: Cache conversation list
  WI-M5: Smart polling (SSE-aware)
```

---

## Expected UX Impact

| Interaction | Before | After |
|-------------|--------|-------|
| Open Chat A | Spinner (200-500ms) | Spinner (first time only) |
| Switch to Chat B then back to A | Spinner → Spinner | Spinner → **Instant** |
| Close tab, reopen, open Chat A | Spinner (full refetch) | **Instant** (IndexedDB) + silent background sync |
| Idle conversation (15s poll) | Fetch 50 messages every 15s | **No fetch** (SSE handles live updates) |
| SSE reconnect after drop | Wait for next 15s poll | **Immediate sync** of missed messages |
| Open chat page (inbox) | Spinner (full list fetch) | **Instant** (React Query cache) |
| New message in another chat | Not visible until next poll | **Real-time** chat list reorder |

---

## Key Design Decisions

### Why React Query + IndexedDB (not just React Query)?

React Query's in-memory cache doesn't survive page refresh. For messaging, users expect conversations to be "there" when they return — like any native chat app. IndexedDB gives us cross-session persistence with zero UX cost.

### Why not persist the full React Query cache to IndexedDB?

React Query has an official `persistQueryClient` adapter, but it serializes the entire query cache — all queries, all data. For messaging, we only want to persist message data, not leaderboard data or other cached API responses. A targeted IndexedDB store per chat gives us precise control over eviction and storage limits.

### Why `since` parameter instead of just diffing client-side?

We could fetch 50 messages and diff client-side (the current polling approach). But this transfers ~15KB per poll for idle conversations. The `since` parameter returns 0 bytes for idle conversations and only the new messages for active ones. At 15s intervals across thousands of users, this is a meaningful bandwidth and DB load reduction.

### Why keep SSE + polling?

SSE is the primary real-time channel. Polling exists only as a fallback for when SSE drops (Vercel serverless can kill long-running connections). With WI-M5, polling is disabled when SSE is healthy — it's a safety net, not the primary mechanism.

---

## Files Modified Per Work Item

| WI | New Files | Modified Files |
|----|-----------|---------------|
| **WI-M1** | (none) | `apps/web/src/hooks/useChatMessages.ts` (major rewrite: useState→useQuery, export `replaceOptimisticMessage`+`isMatchingOptimistic`), `apps/web/src/components/chats/hooks/useChatPage.ts` (remove duplicate message fetch from `loadChatDetails`) |
| **WI-M2** | `apps/web/src/lib/chat/message-store.ts`, `apps/web/src/lib/chat/hydrateChatCache.ts` | `apps/web/src/hooks/useChatMessages.ts` (add persist effect), `apps/web/src/components/providers/Providers.tsx` (add hydration call), `apps/web/package.json` (add `idb-keyval`) |
| **WI-M3** | (none) | `apps/web/src/app/api/chats/[id]/route.ts` (add `after` query param — new code path with `gt`+`asc`), `apps/web/src/hooks/useChatMessages.ts` (add `syncNewMessages` function) |
| **WI-M4** | (none) | `apps/web/src/components/chats/hooks/useChatPage.ts` (wrap `loadChats` in useQuery) |
| **WI-M5** | (none) | `apps/web/src/hooks/useChatMessages.ts` (SSE-aware polling toggle — mostly handled by WI-M1 already) |

---

## Validation Checklist

```bash
# Quality gate
bun run check && bun run typecheck && bun run lint

# Tests
bun run test:unit

# Build
bun run build

# Manual validation
# 1. Open Chat A → spinner on first load → messages appear
# 2. Switch to Chat B → spinner (first visit)
# 3. Switch back to Chat A → INSTANT (React Query cache, no spinner)
# 4. Send a message in Chat A → appears immediately (optimistic)
# 5. Receive a message via SSE → appears in real-time
# 6. Close the browser tab completely
# 7. Reopen, navigate to Chat A → INSTANT (IndexedDB) + background sync
# 8. Check Network tab: background revalidation uses ?since= parameter
# 9. Disconnect SSE (throttle network) → polling starts at 15s
# 10. Reconnect SSE → immediate sync of missed messages, polling stops
# 11. Open chat page (inbox) → INSTANT on second visit (cached list)
# 12. Receive message in Chat B while viewing Chat A → Chat B moves to top of list
```

---

## Storage Estimates

| Data | Size per item | Items | Total |
|------|--------------|-------|-------|
| Message (avg) | ~300 bytes | 100 per chat | 30 KB per chat |
| Cached chats | 30 KB per chat | 50 chats max | **1.5 MB total** |
| Chat list | ~500 bytes per chat | 100 chats | **50 KB** |
| **Total IndexedDB** | | | **~1.6 MB** |

Well within IndexedDB limits (typically 50MB+ per origin). No risk of hitting storage quotas.
