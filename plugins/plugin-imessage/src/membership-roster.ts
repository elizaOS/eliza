/**
 * Roster source adapter bridging the chat.db reader to the membership
 * publisher (issue #24370): derives per-chat participant rosters with
 * handle services from `chat`, `chat_handle_join`, and `handle`, with a
 * monotonic read counter so every sweep produces a distinct evidence
 * cursor.
 *
 * Failure semantics: the underlying reader's `listChats` swallows query
 * errors and returns `[]` (its documented degrade-to-send-only contract),
 * which is indistinguishable from an empty database at the return-value
 * boundary. The reader exposes a monotonic `rosterReadFailureCount()` for
 * exactly this ambiguity: this adapter checks it around every enumeration
 * and converts an observed increment into a thrown roster failure so the
 * publisher degrades fail-closed instead of publishing nothing while stale
 * evidence stays authoritative.
 */
import type { ChatDbChatSummary, ChatDbReader } from "./chatdb-reader";
import type { IMessageMembershipRosterSource, IMessageRosterRead } from "./membership";

/**
 * Handle → service map read once per adapter construction. chat.db's
 * handle table is small (one row per distinct counterpart); reading it in
 * full keeps roster enrichment trivial and deterministic.
 */
interface HandleServiceIndex {
  get(handle: string): string | null;
}

export function createHandleServiceIndex(
  pairs: ReadonlyMap<string, string | null>
): HandleServiceIndex {
  return {
    get(handle: string): string | null {
      return pairs.get(handle) ?? null;
    },
  };
}

export class IMessageRosterReadFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IMessageRosterReadFailedError";
  }
}

/**
 * Build a membership roster source over a chat.db reader. The reader's
 * `listChats` already joins chat_handle_join; this adapter re-shapes each
 * summary into the publisher's roster read shape.
 */
export function createChatDbRosterSource(
  reader: ChatDbReader,
  handleServices?: HandleServiceIndex
): IMessageMembershipRosterSource {
  let counter = 0;
  const cache = new Map<string, ChatDbChatSummary>();

  function rosterFor(summary: ChatDbChatSummary): IMessageRosterRead {
    counter += 1;
    const participants = summary.participants.map((handle) => ({
      handle,
      service: handleServices ? handleServices.get(handle) : null,
    }));
    return {
      chatId: summary.chatId,
      chatType: summary.chatType,
      displayName: summary.displayName,
      participants,
      cursor: counter,
    };
  }

  function enumerate(): ChatDbChatSummary[] {
    const failuresBefore = reader.rosterReadFailureCount();
    const chats = reader.listChats();
    // A roster-query failure under this enumeration makes the (empty or
    // partial) return untrustworthy: the reader degrades to `[]` on any
    // query error, so a TCC-revoked or corrupt database is observationally
    // identical to a healthy empty one. Report the failure to the
    // publisher, which degrades fail-closed.
    if (reader.rosterReadFailureCount() > failuresBefore) {
      throw new IMessageRosterReadFailedError(
        "chat.db roster enumeration query failed (reader degraded to an empty result; suspected TCC/database access loss)"
      );
    }
    return chats;
  }

  return {
    listChatIds(): readonly string[] {
      const chats = enumerate();
      cache.clear();
      for (const chat of chats) {
        cache.set(chat.chatId, chat);
      }
      return [...cache.keys()];
    },
    readRoster(chatId: string): IMessageRosterRead | null {
      const cached = cache.get(chatId);
      const summary = cached ?? enumerate().find((c) => c.chatId === chatId);
      if (!summary) return null;
      if (!cached) cache.set(chatId, summary);
      return rosterFor(summary);
    },
  };
}
