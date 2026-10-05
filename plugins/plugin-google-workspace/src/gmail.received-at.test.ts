/**
 * Inbox Gmail search (`searchMessages` → `mapMessage`) stamps `receivedAt` from
 * the sender Date header with `new Date(header).toISOString()`. A malformed
 * Date throws RangeError and aborts the whole search page; a missing Date
 * leaves `receivedAt` undefined so the inbox falls back to sync time. Gmail
 * already supplies `internalDate` (mailbox epoch ms); the rich triage mapper
 * uses it. These tests drive the real `GoogleGmailClient` with a stubbed
 * messages.get/list payload; deterministic, no network.
 */
import { describe, expect, it, vi } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory.js";
import { GoogleGmailClient } from "./gmail.js";

const MAILBOX_MS = "1715083200000";
const MAILBOX_ISO = "2024-05-07T12:00:00.000Z";

function clientReturning(data: Record<string, unknown>): GoogleGmailClient {
  const get = vi.fn().mockResolvedValue({ data });
  const factory = {
    gmail: vi.fn().mockResolvedValue({ users: { messages: { get } } }),
  } as unknown as GoogleApiClientFactory;
  return new GoogleGmailClient(factory);
}

function payload(args: {
  id?: string;
  dateHeader?: string | null;
  internalDate?: string;
}): Record<string, unknown> {
  const headers: Array<{ name: string; value: string }> = [
    { name: "Subject", value: "Status" },
    { name: "From", value: "Ada <ada@example.com>" },
    { name: "To", value: "me@example.com" },
  ];
  if (args.dateHeader !== null && args.dateHeader !== undefined) {
    headers.push({ name: "Date", value: args.dateHeader });
  }
  return {
    id: args.id ?? "m1",
    threadId: "t1",
    snippet: "hello",
    labelIds: ["INBOX"],
    ...(args.internalDate === undefined ? {} : { internalDate: args.internalDate }),
    payload: { headers },
  };
}

describe("Gmail inbox receivedAt mapping", () => {
  it("keeps a valid Date header when Gmail omits internalDate", async () => {
    const client = clientReturning(payload({ dateHeader: "Thu, 07 May 2026 12:00:00 GMT" }));
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.receivedAt).toBe("2026-05-07T12:00:00.000Z");
  });

  it("uses Gmail internalDate when the sender Date header is missing", async () => {
    const client = clientReturning(payload({ dateHeader: null, internalDate: MAILBOX_MS }));
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.receivedAt).toBe(MAILBOX_ISO);
  });

  it("does not throw when the sender Date header is not a date", async () => {
    const client = clientReturning(payload({ dateHeader: "not-a-date", internalDate: MAILBOX_MS }));
    const msg = await client.getMessage({ accountId: "a1", messageId: "m1" });
    expect(msg.receivedAt).toBe(MAILBOX_ISO);
  });

  it("returns the rest of a search page when one message has a garbage Date", async () => {
    const get = vi.fn(async ({ id }: { id: string }) => ({
      data:
        id === "bad"
          ? payload({
              id: "bad",
              dateHeader: "unknown",
              internalDate: MAILBOX_MS,
            })
          : payload({
              id: "good",
              dateHeader: "Thu, 07 May 2026 12:00:00 GMT",
              internalDate: "1715086800000", // 2024-05-07T13:00:00.000Z
            }),
    }));
    const list = vi.fn().mockResolvedValue({
      data: { messages: [{ id: "good" }, { id: "bad" }] },
    });
    const factory = {
      gmail: vi.fn().mockResolvedValue({ users: { messages: { get, list } } }),
    } as unknown as GoogleApiClientFactory;
    const client = new GoogleGmailClient(factory);

    const results = await client.searchMessages({
      accountId: "a1",
      query: "in:inbox",
      limit: 2,
    });

    expect(results.map((message) => message.id)).toEqual(["good", "bad"]);
    expect(results[0]?.receivedAt).toBe("2024-05-07T13:00:00.000Z");
    expect(results[1]?.receivedAt).toBe(MAILBOX_ISO);
  });
});
