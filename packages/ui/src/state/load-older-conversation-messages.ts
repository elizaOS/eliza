/**
 * Orchestrates one older-page load for the infinite upward scroll (#13532).
 *
 * The cursor is the timestamp of the oldest currently retained message. The
 * caller owns scroll anchoring; this helper owns the API cursor, transcript
 * filtering, prepend dispatch, and the `hasMore` result that gates the next
 * fetch. One load may issue a bounded number of page fetches: fully
 * non-renderable pages advance the cursor in-invocation (see
 * MAX_FILTERED_PAGE_HOPS) because the retained-oldest cursor alone can never
 * move past them.
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
   * first element's timestamp; an empty thread has no cursor to page below.
   */
  currentMessages: ConversationMessage[];
  /** Prepend the older, renderable turns in front of the thread. */
  prependMessages: (older: ConversationMessage[]) => void;
  /** Page size hint; the server may clamp it. */
  limit?: number;
  signal?: AbortSignal;
}

export interface LoadOlderResult {
  /** Whether the server reports more older turns beyond this page. */
  hasMore: boolean;
  /** How many renderable turns were prepended. */
  prependedCount: number;
}

/**
 * How many consecutive fully-non-renderable pages one invocation will hop
 * past. The cursor is the oldest RETAINED (renderable) message, so a page
 * where every turn filters out (a run of silent assistant turns) would
 * otherwise leave the cursor parked and every retry would refetch the same
 * page. Bounded so a pathological store can't spin the client.
 */
const MAX_FILTERED_PAGE_HOPS = 5;

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

  const oldest = currentMessages[0];
  if (!oldest || typeof oldest.timestamp !== "number") {
    return { hasMore: false, prependedCount: 0 };
  }

  let cursor = oldest.timestamp;
  for (let hop = 0; hop < MAX_FILTERED_PAGE_HOPS; hop++) {
    const response = await client.getConversationMessages(conversationId, {
      before: cursor,
      ...(limit !== undefined ? { limit } : {}),
      ...(signal ? { signal } : {}),
    });

    if (response.messages.length === 0) {
      return { hasMore: false, prependedCount: 0 };
    }

    const older = filterRenderableConversationMessages(response.messages);
    const hasMore = response.hasMore === true;

    if (older.length > 0) {
      prependMessages(older);
      return { hasMore, prependedCount: older.length };
    }
    if (!hasMore) {
      return { hasMore: false, prependedCount: 0 };
    }
    // Every turn on this page filtered out. Advance the cursor past the page
    // (messages arrive ascending; [0] is its oldest) and fetch the next one —
    // the retained thread's oldest message can't move, so without this hop the
    // next attempt would refetch this exact page.
    cursor = response.messages[0].timestamp;
  }

  // Hop budget exhausted with more history behind the filtered run: report
  // hasMore so a later scroll-up (with the same in-invocation hops) resumes.
  return { hasMore: true, prependedCount: 0 };
}
