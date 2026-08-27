/**
 * Roster source adapter bridging the chat.db reader to the membership
 * publisher (issue #24370): derives per-chat participant rosters with
 * handle services from `chat`, `chat_handle_join`, and `handle`, with a
 * monotonic read counter so every sweep produces a distinct evidence
 * cursor. Read failures propagate as thrown errors — the publisher
 * degrades fail-closed on them.
 */
import type { ChatDbChatSummary, ChatDbReader } from "./chatdb-reader";
import type { IMessageMembershipRosterSource, IMessageRosterRead } from "./membership";

/**
 * Handle → service map read once per adapter construction. chat.db's
 * handle table is small (one row per distinct counterpart); reading it in
 * full keeps the roster join trivial and deterministic.
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

/**
 * Build a membership roster source over a chat.db reader. The reader's
 * `listChats` already joins chat_handle_join; this adapter re-shapes each
 * summary into the publisher's roster read and stamps a monotonic cursor.
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

  return {
    listChatIds(): readonly string[] {
      const chats = reader.listChats();
      cache.clear();
      for (const chat of chats) {
        cache.set(chat.chatId, chat);
      }
      return [...cache.keys()];
    },
    readRoster(chatId: string): IMessageRosterRead | null {
      const cached = cache.get(chatId);
      const summary = cached ?? reader.listChats().find((c) => c.chatId === chatId);
      if (!summary) return null;
      if (!cached) cache.set(chatId, summary);
      return rosterFor(summary);
    },
  };
}
