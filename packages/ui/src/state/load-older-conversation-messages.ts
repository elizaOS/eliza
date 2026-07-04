/**
 * Orchestrates ONE older-page fetch for the infinite upward scroll (#13532).
 *
 * Extracted as a pure, dependency-injected function (like
 * `hydrateInitialConversation`) so the paging contract can be unit-tested
 * without React: given the current oldest message it computes the `before`
 * cursor, fetches a page over HTTP, filters it to renderable turns, prepends
 * the older turns, and reports back whether more remain.
 *
 * The cursor is the createdAt (`timestamp`) of the current OLDEST loaded
 * message. The server returns turns strictly older than the cursor plus a
 * `hasMore` flag; we prepend them (dedupe + cap live in the reducer /
 * `prependConversationMessages`) and thread `hasMore` back so the caller can
 * latch the loader off at the true top.
 *
 * Returns the resolved `hasMore` (false on empty page or an explicit
 * `hasMore:false`) so the caller updates its gate synchronously. Fetch failures
 * propagate so the scroll hook's in-flight guard re-arms for a retry.
 */

import type { ConversationMessage } from "../api";
import { filterRenderableConversationMessages } from "./conversation-message-filter";

export interface LoadOlderClient {
  getConversationMessages(
    id: string,
    options?: {
      signal?: AbortSignal;
      before?: number;
      limit?: number;
    },
  ): Promise<{ messages: ConversationMessage[]; hasMore?: boolean }>;
}

export interface LoadOlderConversationMessagesDeps {
  client: LoadOlderClient;
  conversationId: string;
  /**
   * The thread as currently held (oldest first). The `before` cursor is the
   * FIRST element's timestamp; an empty thread has no cursor so there is
   * nothing older to load.
   */
  currentMessages: ConversationMessage[];
  /** Prepend the older, renderable turns in front of the thread (deduped/capped). */
  prependMessages: (older: ConversationMessage[]) => void;
  /** Page size hint (server-clamped). */
  limit?: number;
  signal?: AbortSignal;
}

export interface LoadOlderResult {
  /** Whether the server reports more older turns beyond this page. */
  hasMore: boolean;
  /** How many renderable turns were prepended (0 = nothing new). */
  prependedCount: number;
}

export async function loadOlderConversationMessages(
  deps: LoadOlderConversationMessagesDeps,
): Promise<LoadOlderResult> {
  const {
    client,
    conversationId,
    currentMessages,
    prependMessages,
    limit,
    signal,
  } = deps;

  // The cursor is the oldest currently-held message's timestamp. With no
  // messages there is no anchor to page below — treat as "nothing older".
  const oldest = currentMessages[0];
  if (!oldest || typeof oldest.timestamp !== "number") {
    return { hasMore: false, prependedCount: 0 };
  }

  const response = await client.getConversationMessages(conversationId, {
    before: oldest.timestamp,
    ...(limit !== undefined ? { limit } : {}),
    ...(signal ? { signal } : {}),
  });

  const older = filterRenderableConversationMessages(response.messages);
  // An empty page means we've hit the true top even if the server didn't say so
  // (e.g. every older turn was a non-renderable action log). Only advertise
  // hasMore when the server said so AND the raw page was non-empty.
  const rawEmpty = response.messages.length === 0;
  const hasMore = rawEmpty ? false : response.hasMore === true;

  if (older.length > 0) {
    prependMessages(older);
  }

  return { hasMore, prependedCount: older.length };
}
