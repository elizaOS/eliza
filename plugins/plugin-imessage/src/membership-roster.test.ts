/**
 * Roster-adapter failure semantics for the native membership publisher
 * (#24370): the real chat.db reader degrades `listChats` to `[]` on query
 * failure by contract, so the adapter must detect the swallowed failure
 * through the reader's monotonic failure counter and throw, letting the
 * publisher degrade fail-closed — a TCC-revoked or corrupt database must
 * never look like a healthy empty roster. Harness is synthetic at the
 * reader seam only; the adapter under test is the production one.
 */
import { describe, expect, it } from "vitest";
import type { ChatDbReader } from "./chatdb-reader";
import { createChatDbRosterSource } from "./membership-roster";

/** Reader stub mirroring the real degrade-to-empty failure contract. */
function makeReader(opts: {
  chats: Array<{ chatId: string; participants: string[] }>;
  failNextListChats?: boolean;
}): ChatDbReader & { failNext: () => void } {
  let failNext = opts.failNextListChats === true;
  let failures = 0;
  const stub = {
    fetchNewMessages: () => [],
    getLatestRowId: () => 0,
    getLatestOwnMessageTimestamp: () => null,
    listMessages: () => [],
    listChats: () => {
      if (failNext) {
        failNext = false;
        failures += 1;
        // The real reader logs and returns [] here.
        return [];
      }
      return opts.chats.map((c) => ({
        chatId: c.chatId,
        chatType: "direct" as const,
        displayName: null,
        serviceName: "iMessage",
        participants: c.participants,
        lastReadMessageTimestamp: 0,
      }));
    },
    rosterReadFailureCount: () => failures,
    close: () => {},
    failNext: () => {
      failNext = true;
    },
  };
  return stub as unknown as ChatDbReader & { failNext: () => void };
}

describe("createChatDbRosterSource failure semantics", () => {
  it("enumerates healthy reads normally", () => {
    const reader = makeReader({
      chats: [{ chatId: "Imessage;-;+155****101", participants: ["+155****101"] }],
    });
    const source = createChatDbRosterSource(reader);
    expect([...source.listChatIds()]).toEqual(["Imessage;-;+155****101"]);
    const roster = source.readRoster("Imessage;-;+155****101");
    expect(roster?.participants[0]?.handle).toBe("+155****101");
  });

  it("treats a swallowed listChats query failure as a roster read failure", () => {
    const reader = makeReader({
      chats: [{ chatId: "c1", participants: ["+155****102"] }],
    });
    const source = createChatDbRosterSource(reader);
    expect([...source.listChatIds()]).toEqual(["c1"]);

    // TCC revocation mid-run: the query fails, the reader returns [], and
    // the adapter must convert the observation into a thrown failure.
    reader.failNext();
    expect(() => source.listChatIds()).toThrow(/roster enumeration query failed/);
  });

  it("an empty healthy database stays a legitimate empty roster", () => {
    const reader = makeReader({ chats: [] });
    const source = createChatDbRosterSource(reader);
    expect([...source.listChatIds()]).toEqual([]);
  });
});
