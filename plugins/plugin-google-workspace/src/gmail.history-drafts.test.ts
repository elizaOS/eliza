/**
 * Verifies Gmail's provider-backed incremental history and draft boundaries.
 * The googleapis client is deterministic and mocked; assertions cover cursor
 * receipts, tombstones, expired-cursor recovery signals, and unsent drafts.
 */

import { describe, expect, it, vi } from "vitest";
import type { GoogleApiClientFactory } from "./client-factory.js";
import { GoogleGmailClient } from "./gmail.js";

function clientFor(gmail: object): GoogleGmailClient {
  return new GoogleGmailClient({
    gmail: vi.fn(async () => gmail),
  } as unknown as GoogleApiClientFactory);
}

describe("Gmail search pages", () => {
  function messageGet() {
    return vi.fn(async ({ id }: { id: string }) => ({
      data: {
        id,
        threadId: `thread-${id}`,
        labelIds: ["INBOX"],
        snippet: `Snippet ${id}`,
        internalDate: "1755849600000",
        payload: { headers: [{ name: "Subject", value: `Subject ${id}` }] },
      },
    }));
  }

  it("returns one provider page with the provider continuation token", async () => {
    const list = vi.fn(async () => ({
      data: {
        messages: [{ id: "m1" }, { id: "m2" }, { id: "" }],
        nextPageToken: "page-2",
      },
    }));
    const client = clientFor({ users: { messages: { list, get: messageGet() } } });

    const page = await client.searchGmailMessagesPage({
      accountId: "account",
      query: "newer_than:30d",
      pageToken: "page-1",
      pageSize: 100,
    });

    expect(page.nextPageToken).toBe("page-2");
    expect(page.messages.map((message) => message.externalId).sort()).toEqual(["m1", "m2"]);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "me",
        q: "newer_than:30d",
        pageToken: "page-1",
        maxResults: 100,
      })
    );
  });

  it("reports the final page with a null token and no caller-side ceiling", async () => {
    const list = vi.fn(async () => ({
      data: { messages: [{ id: "m3" }], nextPageToken: "   " },
    }));
    const client = clientFor({ users: { messages: { list, get: messageGet() } } });

    const page = await client.searchGmailMessagesPage({
      accountId: "account",
      query: "newer_than:7d",
    });

    expect(page).toMatchObject({ nextPageToken: null });
    expect(page.messages).toHaveLength(1);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ maxResults: 500 }));
  });
});

describe("Gmail history sync", () => {
  it("maps a page with durable cursor and deletion/label provenance", async () => {
    const list = vi.fn(async () => ({
      data: {
        historyId: "105",
        nextPageToken: "next",
        history: [
          {
            id: "104",
            messagesAdded: [
              { message: { id: "added", threadId: "thread-a", labelIds: ["INBOX"] } },
            ],
            messagesDeleted: [{ message: { id: "deleted", threadId: "thread-d" } }],
            labelsAdded: [
              {
                message: { id: "labeled", threadId: "thread-l", labelIds: ["STARRED"] },
                labelIds: ["STARRED"],
              },
            ],
            labelsRemoved: [],
          },
        ],
      },
    }));
    const client = clientFor({ users: { history: { list } } });

    await expect(
      client.listGmailHistoryPage({ accountId: "account", startHistoryId: "100" })
    ).resolves.toEqual({
      historyId: "105",
      nextPageToken: "next",
      changes: [
        {
          historyId: "104",
          messagesAdded: [{ messageId: "added", threadId: "thread-a", labelIds: ["INBOX"] }],
          messagesDeleted: [{ messageId: "deleted", threadId: "thread-d", labelIds: [] }],
          labelsAdded: [
            {
              messageId: "labeled",
              threadId: "thread-l",
              labelIds: ["STARRED"],
              changedLabelIds: ["STARRED"],
            },
          ],
          labelsRemoved: [],
        },
      ],
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "me", startHistoryId: "100", maxResults: 500 })
    );
  });

  it("returns a typed resync signal when Google expires the cursor", async () => {
    const list = vi.fn(async () => {
      throw { response: { status: 404 } };
    });
    const client = clientFor({ users: { history: { list } } });

    await expect(
      client.listGmailHistoryPage({ accountId: "account", startHistoryId: "expired" })
    ).rejects.toMatchObject({ code: "GOOGLE_GMAIL_HISTORY_CURSOR_EXPIRED" });
  });
});

describe("Gmail provider drafts", () => {
  it("creates an unsent draft and returns provider ids", async () => {
    const create = vi.fn(async () => ({
      data: {
        id: "draft-1",
        message: { id: "message-1", threadId: "thread-1", labelIds: ["DRAFT"] },
      },
    }));
    const client = clientFor({ users: { drafts: { create } } });

    await expect(
      client.createGmailDraft({
        accountId: "account",
        to: ["owner@example.com"],
        subject: "Review only",
        bodyText: "This must remain unsent.",
      })
    ).resolves.toEqual({
      draftId: "draft-1",
      messageId: "message-1",
      threadId: "thread-1",
      labelIds: ["DRAFT"],
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "me",
        requestBody: expect.objectContaining({
          message: expect.objectContaining({ raw: expect.any(String) }),
        }),
      })
    );
  });
});

describe("Gmail mutation receipts", () => {
  it("deduplicates ids and reports retryable per-message trash failures", async () => {
    const trash = vi
      .fn()
      .mockResolvedValueOnce({ data: { id: "message-1" } })
      .mockRejectedValueOnce(new Error("connection reset"));
    const client = clientFor({ users: { messages: { trash } } });

    await expect(
      client.modifyGmailMessages({
        accountId: "account",
        messageIds: ["message-1", "message-1", "message-2"],
        operation: "trash",
      })
    ).resolves.toEqual({
      operation: "trash",
      requestedMessageIds: ["message-1", "message-2"],
      succeededMessageIds: ["message-1"],
      failures: [{ messageId: "message-2", code: null, retryable: true }],
    });
    expect(trash).toHaveBeenCalledTimes(2);
  });

  it("does not classify a provider validation rejection as retryable", async () => {
    const trash = vi.fn(async () => {
      throw { response: { status: 400 } };
    });
    const client = clientFor({ users: { messages: { trash } } });

    await expect(
      client.modifyGmailMessages({
        accountId: "account",
        messageIds: ["invalid"],
        operation: "trash",
      })
    ).resolves.toMatchObject({
      succeededMessageIds: [],
      failures: [{ messageId: "invalid", code: 400, retryable: false }],
    });
  });
});
