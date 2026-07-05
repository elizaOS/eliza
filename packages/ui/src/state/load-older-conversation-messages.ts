/**
 * Orchestrates one older-page fetch for the infinite upward scroll (#13532).
 *
 * The cursor is the timestamp of the oldest currently retained message. The
 * caller owns scroll anchoring; this helper owns the API cursor, transcript
 * filtering, prepend dispatch, and the `hasMore` result that gates the next
 * fetch.
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

  const response = await client.getConversationMessages(conversationId, {
    before: oldest.timestamp,
    ...(limit !== undefined ? { limit } : {}),
    ...(signal ? { signal } : {}),
  });

  const older = filterRenderableConversationMessages(response.messages);
  const hasMore =
    response.messages.length === 0 ? false : response.hasMore === true;

  if (older.length > 0) {
    prependMessages(older);
  }

  return { hasMore, prependedCount: older.length };
}
