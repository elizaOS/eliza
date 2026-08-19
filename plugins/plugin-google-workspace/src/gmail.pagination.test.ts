/**
 * `searchGmailMessages`/`getGmailSubscriptionHeaders` loop `while (results.length
 * < limit)`, but that count only advances on a page with at least one mapped
 * message — a page with an empty `messages` array and a distinct
 * `nextPageToken` never grows it. Both must still terminate against a
 * repeated or a never-repeating-but-never-stopping page token. Mirrors the
 * equivalent Calendar pagination coverage in `calendar.pagination.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory.js";
import { GoogleGmailClient } from "./gmail.js";

function clientFor(list: ReturnType<typeof vi.fn>): GoogleGmailClient {
  const factory = {
    gmail: vi.fn(async () => ({ users: { messages: { list } } })),
  } as unknown as GoogleApiClientFactory;
  return new GoogleGmailClient(factory);
}

describe("searchGmailMessages pagination", () => {
  it("stops once the API stops returning a next cursor, even on empty pages", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: { messages: [], nextPageToken: "c1" } })
      .mockResolvedValueOnce({ data: { messages: [] } });
    const client = clientFor(list);

    const result = await client.searchGmailMessages({ accountId: "acct-1", query: "in:inbox" });

    expect(result).toEqual([]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("rejects a cursor cycle instead of looping forever on empty pages", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: { messages: [], nextPageToken: "A" } })
      .mockResolvedValueOnce({ data: { messages: [], nextPageToken: "B" } })
      .mockResolvedValueOnce({ data: { messages: [], nextPageToken: "A" } });
    const client = clientFor(list);

    await expect(
      client.searchGmailMessages({ accountId: "acct-1", query: "in:inbox" })
    ).rejects.toMatchObject({ code: "GOOGLE_GMAIL_PAGINATION_LOOP" });
    // Exactly 3 calls: the cycle back to "A" is caught on the page that
    // returns it, not after further oscillation.
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("bounds pagination against a provider that mints a novel token on every empty page", async () => {
    let page = 0;
    const list = vi.fn(async () => {
      page += 1;
      return { data: { messages: [], nextPageToken: `token-${page}` } };
    });
    const client = clientFor(list);

    await expect(
      client.searchGmailMessages({ accountId: "acct-1", query: "in:inbox" })
    ).rejects.toMatchObject({ code: "GOOGLE_GMAIL_PAGINATION_LIMIT_EXCEEDED" });
    expect(list).toHaveBeenCalledTimes(1_000);
  });
});

describe("getGmailSubscriptionHeaders pagination", () => {
  it("stops once the API stops returning a next cursor, even on empty pages", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: { messages: [], nextPageToken: "c1" } })
      .mockResolvedValueOnce({ data: { messages: [] } });
    const client = clientFor(list);

    const result = await client.getGmailSubscriptionHeaders({ accountId: "acct-1" });

    expect(result).toEqual([]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("bounds pagination against a provider that mints a novel token on every empty page", async () => {
    let page = 0;
    const list = vi.fn(async () => {
      page += 1;
      return { data: { messages: [], nextPageToken: `token-${page}` } };
    });
    const client = clientFor(list);

    await expect(client.getGmailSubscriptionHeaders({ accountId: "acct-1" })).rejects.toMatchObject(
      { code: "GOOGLE_GMAIL_PAGINATION_LIMIT_EXCEEDED" }
    );
    expect(list).toHaveBeenCalledTimes(1_000);
  });
});
