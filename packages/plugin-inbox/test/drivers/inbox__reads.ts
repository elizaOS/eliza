// spec/inbox/reads.md, "Story: Read my mailbox without mixing account pages or endlessly reusing a cursor"; spec/inbox/reads.md, "Pages keep their first read's identity and expose mailbox shifts"
import { Effect } from "effect";
import type { Driver, Options } from "../../gen/inbox__reads.conformance.ts";
import type { MailboxFeed as FeedState, MailboxQuery } from "../../gen/inbox__reads.ts";
import { mailboxFeed, type MailboxFeed, type MailboxFolder, type MailboxListRequest } from "@elizaos/plugin-inbox-client";
import type { GmailMessage } from "@elizaos/plugin-inbox-client";

const feeds = new Map<string, MailboxFeed>();

const feedFor = (key: string): MailboxFeed => {
  const found = feeds.get(key);
  if (found) return found;
  const made = Effect.runSync(mailboxFeed());
  feeds.set(key, made);
  return made;
};

const requestOf = (query: MailboxQuery): MailboxListRequest => ({
  connectionId: query.connection > 0 ? `connection-${query.connection}` : "",
  folder: query.folder as MailboxFolder,
  search: query.query,
});

const messageOf = (id: string): GmailMessage => ({
  id, threadId: `thread-${id}`, subject: "", from: "", fromEmail: null, to: [], cc: [], snippet: "", receivedAt: "2026-11-20T10:00:00.000Z",
  unread: false, starred: false, historyId: null,
});

const connected = (state: FeedState): FeedState => ({ ...state, key: { ...state.key, connection: state.key.connection > 0 ? 1 : 0 } });

export const driver: Driver<FeedState> = {
  reset: () => { feeds.clear(); },
  dispatch: (key, event) => {
    const feed = feedFor(key);
    switch (event.type) {
      case "begin": return Effect.runSync(feed.begin(requestOf(event.query))) === null ? "refused" : "accepted";
      case "disconnect": return Effect.runSync(feed.disconnect()) ? "accepted" : "refused";
      case "acceptPage": {
        const page = {
          messages: event.page.messages.map(messageOf), syncedAt: "2026-11-20T10:00:00.000Z", nextPageToken: event.page.nextCursor === "" ? null : event.page.nextCursor,
          mailboxHistoryId: event.page.providerHistory, supportsSpamTrash: true,
        };
        const receipt = { request: requestOf(event.query), load: event.receiptLoad };
        return Effect.runSync(feed.accept(receipt, event.pageToken === "" ? null : event.pageToken, page)) ? "accepted" : "refused";
      }
    }
  },
  observe: (key) => connected(Effect.runSync(feedFor(key).state())),
};

export const options: Options<FeedState> = { view: connected, keys: ["list-a", "list-b"] };
