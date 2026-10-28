/**
 * Mailbox list state: folder queries, cursor paging with mailbox revisions,
 * bounded list and body caches, saved snapshot validation and the Home
 * attention summary. Synthetic messages only; no provider or network.
 */
import { describe, expect, it } from "vitest";
import {
  inboxAttentionFor,
  MAIL_BODY_LIMITS,
  MAILBOX_FOLDER_QUERY,
  MAILBOX_LIST_LIMITS,
  MailBodyCache,
  MailboxListCache,
  type MailboxListSnapshot,
  mailboxListStatus,
  mergeMailboxPage,
  nextMailboxCursor,
  readSavedInboxSummary,
  readSavedMailbox,
} from "../../src/mailbox/mailbox-list.ts";
import type { GmailAccount, GmailMessage } from "../../src/mailbox/types.ts";

const message = (id: string, unread = false): GmailMessage => ({
  id,
  threadId: `t-${id}`,
  subject: `Subject ${id}`,
  from: "Sender",
  fromEmail: "sender@example.com",
  to: ["owner@example.com"],
  snippet: `Snippet ${id}`,
  receivedAt: "2026-10-27T10:00:00Z",
  unread,
});
const account = (
  connectionId: string,
  capabilities = ["google.gmail.triage"],
): GmailAccount => ({
  configured: true,
  connected: true,
  reason: "connected",
  connectionId,
  grantedCapabilities: capabilities,
  label: `${connectionId}@gmail.com`,
});
const list = (
  key: string,
  patch: Partial<MailboxListSnapshot> = {},
): MailboxListSnapshot => ({
  key,
  at: 1_000,
  firstPageRevision: "h1",
  messages: [message("a")],
  query: "in:inbox",
  cursor: null,
  revision: "2026-10-27T10:00:00Z",
  cursors: [],
  newerMail: false,
  status: "1 messages loaded",
  ...patch,
});

describe("folders and status", () => {
  it("lists each folder with its fixed Gmail search", () => {
    expect(MAILBOX_FOLDER_QUERY).toEqual({
      inbox: "in:inbox",
      sent: "in:sent",
      drafts: "in:drafts",
      archive: "in:archive",
      trash: "in:trash",
      starred: "is:starred",
      all: "-in:spam -in:trash",
      spam: "in:spam",
    });
    expect(Object.isFrozen(MAILBOX_FOLDER_QUERY)).toBe(true);
  });

  it("states an empty folder by name and otherwise the loaded count", () => {
    expect(mailboxListStatus(3, "in:inbox")).toBe("3 messages loaded");
    expect(mailboxListStatus(0, "in:inbox")).toBe("Your Inbox is empty");
    expect(mailboxListStatus(0, "in:sent")).toBe("No sent messages");
    expect(mailboxListStatus(0, "in:archive")).toBe("No archived messages");
    expect(mailboxListStatus(0, "in:trash")).toBe("Trash is empty");
    expect(mailboxListStatus(0, "from:someone")).toBe(
      "No messages match this search",
    );
  });
});

describe("paging", () => {
  it("ends paging on a repeated cursor instead of looping", () => {
    const seen = new Set<string>();
    expect(nextMailboxCursor(seen, "c1")).toBe("c1");
    expect(nextMailboxCursor(seen, "c1")).toBeNull();
    expect(nextMailboxCursor(seen, null)).toBeNull();
    expect([...seen]).toEqual(["c1"]);
  });

  it("starts a new list on a first page and keeps its revision", () => {
    const merged = mergeMailboxPage(
      {
        messages: [message("old")],
        firstPageRevision: "h0",
        seenCursors: new Set(["c0"]),
      },
      {
        messages: [message("a"), message("a"), message("b")],
        nextPageToken: "c1",
        mailboxHistoryId: "h1",
      },
      null,
    );
    expect(merged.messages.map((m) => m.id)).toEqual(["a", "b"]);
    expect(merged.firstPageRevision).toBe("h1");
    expect([...merged.seenCursors]).toEqual(["c1"]);
    expect(merged.nextPageToken).toBe("c1");
    expect(merged.shifted).toBe(false);
  });

  it("marks a later page from a changed mailbox, by repeat or by revision", () => {
    const state = {
      messages: [message("a"), message("b")],
      firstPageRevision: "h1",
      seenCursors: new Set(["c1"]),
    };
    const repeated = mergeMailboxPage(
      state,
      {
        messages: [message("b"), message("c")],
        nextPageToken: "c2",
        mailboxHistoryId: "h1",
      },
      "c1",
    );
    expect(repeated.messages.map((m) => m.id)).toEqual(["a", "b", "c"]);
    expect(repeated.shifted).toBe(true);
    expect(repeated.firstPageRevision).toBe("h1");
    expect([...repeated.seenCursors]).toEqual(["c1", "c2"]);

    const removed = mergeMailboxPage(
      state,
      { messages: [message("d")], nextPageToken: "c1", mailboxHistoryId: "h2" },
      "c1",
    );
    expect(removed.shifted).toBe(true);
    // The repeated cursor ends paging.
    expect(removed.nextPageToken).toBeNull();

    const unchanged = mergeMailboxPage(
      state,
      { messages: [message("d")], nextPageToken: null },
      "c1",
    );
    expect(unchanged.shifted).toBe(false);
    // The caller's state is not mutated.
    expect([...state.seenCursors]).toEqual(["c1"]);
    expect(state.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("caches", () => {
  it("keeps at most eight recent lists, never drafts or oversized lists", () => {
    const cache = new MailboxListCache();
    expect(cache.remember(list("drafts", { query: "in:drafts" }))).toBe(false);
    expect(cache.remember(list("empty", { query: "" }))).toBe(false);
    expect(
      cache.remember(
        list("big", {
          messages: Array.from(
            { length: MAILBOX_LIST_LIMITS.messages + 1 },
            (_, i) => message(String(i)),
          ),
        }),
      ),
    ).toBe(false);
    for (let i = 0; i < 10; i++) cache.remember(list(`k${i}`));
    expect(cache.size).toBe(8);
    expect(cache.values().map((row) => row.key)).toEqual([
      "k2",
      "k3",
      "k4",
      "k5",
      "k6",
      "k7",
      "k8",
      "k9",
    ]);
    // Remembering again moves a list to the newest position.
    cache.remember(list("k2"));
    expect(cache.values().at(-1)?.key).toBe("k2");
  });

  it("drops a list at the age limit or with an invalid time", () => {
    const cache = new MailboxListCache();
    cache.remember(list("a", { at: 1_000 }));
    expect(cache.get("a", 1_000 + MAILBOX_LIST_LIMITS.maxAgeMs - 1)?.key).toBe(
      "a",
    );
    expect(
      cache.get("a", 1_000 + MAILBOX_LIST_LIMITS.maxAgeMs),
    ).toBeUndefined();
    expect(cache.size).toBe(0);
    cache.put(list("b", { at: Number.NaN }));
    expect(cache.get("b", 2_000)).toBeUndefined();
  });

  it("keeps a copy, so later edits of the loaded list do not change it", () => {
    const cache = new MailboxListCache();
    const row = list("a");
    cache.remember(row);
    row.messages.push(message("later"));
    row.cursors.push("c9");
    expect(cache.get("a", 2_000)?.messages.map((m) => m.id)).toEqual(["a"]);
    expect(cache.get("a", 2_000)?.cursors).toEqual([]);
  });

  it("bounds bodies by count and bytes, evicting the oldest first", () => {
    const cache = new MailBodyCache<{
      message: { id: string };
      text: string;
    }>();
    for (let i = 0; i < MAIL_BODY_LIMITS.bodies + 2; i++)
      cache.remember(`b${i}`, { message: { id: `b${i}` }, text: "x" }, i);
    expect(cache.values().length).toBe(MAIL_BODY_LIMITS.bodies);
    expect(cache.get("b0")).toBeUndefined();
    expect(cache.get("b17")).toEqual({
      at: 17,
      body: { message: { id: "b17" }, text: "x" },
    });
    const large = "y".repeat(MAIL_BODY_LIMITS.bytes / 2);
    cache.remember("l1", { message: { id: "l1" }, text: large }, 100);
    cache.remember("l2", { message: { id: "l2" }, text: large }, 101);
    expect(cache.get("l2")).toBeDefined();
    expect(cache.get("l1")).toBeUndefined();
    expect(cache.values().length).toBe(1);
  });
});

describe("saved snapshots", () => {
  const now = 10 * 86_400_000;
  const snapshot = () => ({
    accounts: [account("a"), account("b", [])],
    selected: "a",
    spamTrashSearch: true,
    lists: [
      list("x", { at: now - 5_000, cursor: "next" }),
      list("y", {
        at: now - 1_000,
        messages: [message("n1", true), message("n2")],
      }),
      list("sent", { at: now - 10, query: "in:sent" }),
    ],
    bodies: [
      { at: now - 1, body: { message: message("n1"), bodyText: "Hello" } },
      { at: now - 1, body: { message: { id: "" }, bodyText: "Hello" } },
      { at: now - 1, body: { message: message("n2") } },
    ],
  });

  it("summarizes only the newest fresh Inbox page, as metadata", () => {
    const summary = readSavedInboxSummary(snapshot(), "a", now);
    expect(summary).toEqual({
      account: account("a"),
      messages: [
        { id: "n1", subject: "Subject n1", from: "Sender", unread: true },
        { id: "n2", subject: "Subject n2", from: "Sender", unread: false },
      ],
      more: false,
      readAt: now - 1_000,
    });
    expect(readSavedInboxSummary(snapshot(), null, now)?.readAt).toBe(
      now - 1_000,
    );
  });

  it("refuses a summary for another chosen account, an unreadable account or stale pages", () => {
    expect(readSavedInboxSummary(snapshot(), "b", now)).toBeNull();
    expect(
      readSavedInboxSummary({ ...snapshot(), selected: "b" }, null, now),
    ).toBeNull();
    expect(
      readSavedInboxSummary(
        snapshot(),
        "a",
        now + MAILBOX_LIST_LIMITS.maxAgeMs,
      ),
    ).toBeNull();
    const damaged = snapshot();
    (damaged.lists[1].messages[0] as unknown as { unread: string }).unread =
      "yes";
    expect(readSavedInboxSummary(damaged, "a", now)).toBeNull();
    expect(readSavedInboxSummary(null, "a", now)).toBeNull();
  });

  it("restores valid rows for the chosen readable account only", () => {
    const restored = readSavedMailbox<{
      message: { id: string };
      bodyText: string;
    }>(snapshot(), "a");
    expect(restored?.selected).toBe("a");
    expect(restored?.chosen).toEqual(account("a"));
    expect(restored?.spamTrashSearch).toBe(true);
    expect(restored?.lists.map((row) => row.key)).toEqual(["x", "y", "sent"]);
    expect(restored?.bodies.map((row) => row.body.message.id)).toEqual(["n1"]);
    const damaged = snapshot();
    (damaged.lists[0].messages[0] as unknown as { to: null }).to = null;
    expect(readSavedMailbox(damaged, "a")?.lists.map((row) => row.key)).toEqual(
      ["y", "sent"],
    );
    expect(readSavedMailbox(snapshot(), "b")).toBeNull();
    expect(readSavedMailbox({ ...snapshot(), selected: "b" }, null)).toBeNull();
    expect(
      readSavedMailbox({ ...snapshot(), accounts: [{ label: 1 }] }, null),
    ).toBeNull();
    expect(readSavedMailbox({ ...snapshot(), bodies: null }, null)).toBeNull();
  });
});

describe("attention", () => {
  it("counts unread loaded messages with the account label and read time", () => {
    expect(
      inboxAttentionFor(
        [message("a", true), message("b"), message("c", true)],
        true,
        "owner@gmail.com",
        "2026-10-27T10:00:00.000Z",
      ),
    ).toEqual({
      state: "ready",
      unread: 2,
      unreadMore: true,
      source: "owner@gmail.com",
      updatedAt: "2026-10-27T10:00:00.000Z",
    });
    expect(
      inboxAttentionFor([], false, null, "2026-10-27T10:00:00.000Z", "stale")
        .state,
    ).toBe("stale");
  });
});
