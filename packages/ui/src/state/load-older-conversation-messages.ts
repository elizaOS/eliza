/**
 * Orchestrates one older-page load for the infinite upward scroll (#13532).
 *
 * The cursor is the timestamp and id of the oldest retained message. The caller
 * owns scroll anchoring; this helper owns the API cursor, transcript
 * filtering, prepend dispatch, and the `hasMore` result that gates the next
 * fetch. Fully non-renderable pages advance the cursor in-invocation because
 * the retained-oldest cursor alone can never move past them.
 */

import type { ConversationMessage } from "../api";
import { filterRenderableConversationMessages } from "./conversation-message-filter";

export interface LoadOlderClient {
  getConversationMessages(
    id: string,
    options?: {
      signal?: AbortSignal;
      before?: number;
      beforeId?: string;
      limit?: number;
    },
  ): Promise<{ messages: ConversationMessage[]; hasMore?: boolean }>;
}

export interface LoadOlderConversationMessagesDeps {
  client: LoadOlderClient;
  conversationId: string;
  /**
   * The thread as currently held (oldest first). The cursor is the first
   * element's timestamp and id; an empty thread has no cursor to page below.
   */
  currentMessages: ConversationMessage[];
  /** Prepend the older, renderable turns in front of the thread. */
  prependMessages: (older: ConversationMessage[]) => void;
  /** Page size hint; the server may clamp it. */
  limit?: number;
  signal?: AbortSignal;
  /** Cursor returned by a prior time-sliced filtered-page traversal. */
  before?: number;
  /** ID paired with `before` when resuming a filtered-page traversal. */
  beforeId?: string;
  /** Wall-clock budget for one scroll action; traversal resumes on the next action. */
  maxDurationMs?: number;
  /** Deterministic clock seam for tests. */
  now?: () => number;
}

export interface LoadOlderResult {
  /** Whether the server reports more older turns beyond this page. */
  hasMore: boolean;
  /** How many renderable turns were prepended. */
  prependedCount: number;
  /** Continuation for filtered pages when the current operation time slice ends. */
  resumeBefore?: number;
  /** ID paired with `resumeBefore` for an exact continuation. */
  resumeBeforeId?: string;
}

const DEFAULT_FILTERED_TRAVERSAL_DURATION_MS = 1_000;

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

  const now = deps.now ?? Date.now;
  const maxDurationMs =
    typeof deps.maxDurationMs === "number" && deps.maxDurationMs > 0
      ? deps.maxDurationMs
      : DEFAULT_FILTERED_TRAVERSAL_DURATION_MS;
  const deadlineAt = now() + maxDurationMs;
  let cursor = deps.before ?? oldest.timestamp;
  let cursorId = deps.beforeId ?? oldest.id;
  const seenCursors = new Set<string>([`${cursor}:${cursorId}`]);
  while (true) {
    if (now() >= deadlineAt) {
      return {
        hasMore: true,
        prependedCount: 0,
        resumeBefore: cursor,
        resumeBeforeId: cursorId,
      };
    }
    const response = await client.getConversationMessages(conversationId, {
      before: cursor,
      beforeId: cursorId,
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
    const nextCursor = response.messages[0].timestamp;
    const nextCursorId = response.messages[0].id;
    const nextCursorKey = `${nextCursor}:${nextCursorId}`;
    if (
      typeof nextCursor !== "number" ||
      !Number.isFinite(nextCursor) ||
      typeof nextCursorId !== "string" ||
      nextCursorId.length === 0 ||
      nextCursor > cursor ||
      (nextCursor === cursor &&
        nextCursorId.toLowerCase() >= cursorId.toLowerCase()) ||
      seenCursors.has(nextCursorKey)
    ) {
      throw new Error("Conversation pagination did not return an older cursor");
    }
    seenCursors.add(nextCursorKey);
    cursor = nextCursor;
    cursorId = nextCursorId;
    if (now() >= deadlineAt) {
      return {
        hasMore: true,
        prependedCount: 0,
        resumeBefore: cursor,
        resumeBeforeId: cursorId,
      };
    }
  }
}
