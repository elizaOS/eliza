/**
 * Exercises LifeOps Gmail seeding, incremental cursor advancement, expired
 * cursor recovery, and effect confirmation over deterministic provider and
 * repository doubles. No account, network, or mailbox is touched.
 */

import { describe, expect, it, vi } from "vitest";
import { GmailDomain } from "./gmail-service.js";

const grant = {
  id: "connector-account:account-1",
  provider: "google",
  side: "owner",
  connectorAccountId: "account-1",
  identityEmail: "owner@example.com",
  capabilities: [
    "google.gmail.triage",
    "google.gmail.compose",
    "google.gmail.manage",
  ],
};

function providerMessage(id: string) {
  return {
    externalId: id,
    threadId: `thread-${id}`,
    subject: `Subject ${id}`,
    from: "Sender <sender@example.com>",
    fromEmail: "sender@example.com",
    replyTo: null,
    to: ["owner@example.com"],
    cc: [],
    snippet: "Preview",
    receivedAt: "2026-08-22T07:00:00.000Z",
    isUnread: true,
    isImportant: false,
    likelyReplyNeeded: true,
    triageScore: 70,
    triageReason: "Unread inbox message.",
    labels: ["INBOX", "UNREAD"],
    htmlLink: null,
    metadata: {},
  };
}

function harness(args: {
  previousState?: Record<string, unknown> | null;
  listHistory?: ReturnType<typeof vi.fn>;
  historyId?: string;
  searchPages?: ReturnType<typeof vi.fn>;
}) {
  const upsertGmailMessage = vi.fn(async () => undefined);
  const deleteGmailMessages = vi.fn(async () => undefined);
  const deleteGmailMessagesByExternalId = vi.fn(async () => 1);
  const upsertGmailSyncState = vi.fn(async () => undefined);
  const publishGmailSeed = vi.fn(async () => undefined);
  const google = {
    getGmailHistoryId: vi.fn(async () => args.historyId ?? "100"),
    listGmailHistoryPage:
      args.listHistory ??
      vi.fn(async () => ({
        changes: [],
        nextPageToken: null,
        historyId: "101",
      })),
    getGmailMessage: vi.fn(async ({ messageId }: { messageId: string }) =>
      providerMessage(messageId),
    ),
    getMessage: vi.fn(async ({ messageId }: { messageId: string }) => ({
      id: messageId,
      threadId: `thread-${messageId}`,
      subject: "Re: Review",
      from: { email: "sender@example.com", name: "Sender" },
      to: [{ email: "owner@example.com" }],
      receivedAt: "2026-08-22T07:00:00.000Z",
      labelIds: ["INBOX"],
      headers: {
        "Message-Id": "<provider-message@example.com>",
        References: "<earlier-message@example.com>",
      },
    })),
    createGmailDraft: vi.fn(async () => ({
      draftId: "draft-1",
      messageId: "draft-message-1",
      threadId: "thread-message-1",
      labelIds: ["DRAFT"],
    })),
    modifyGmailMessages: vi.fn(
      async ({ messageIds }: { messageIds: string[] }) => ({
        operation: "trash",
        requestedMessageIds: messageIds,
        succeededMessageIds: [messageIds[0]],
        failures: [{ messageId: messageIds[1], code: 429, retryable: true }],
      }),
    ),
    searchGmailMessages: vi.fn(async () => [providerMessage("seeded")]),
    searchGmailMessagesPage:
      args.searchPages ??
      vi.fn(async () => ({
        messages: [providerMessage("seeded")],
        nextPageToken: null,
      })),
  };
  const repository = {
    getGmailSyncState: vi.fn(async () => args.previousState ?? null),
    getGmailMessage: vi.fn(async () => null),
    countGmailMessages: vi.fn(async () => 4),
    countGmailSpamReviewItems: vi.fn(async () => 2),
    upsertGmailMessage,
    deleteGmailMessages,
    deleteGmailMessagesByExternalId,
    deleteGmailMessagesForProvider: vi.fn(async () => undefined),
    deleteGmailSpamReviewItemsForProvider: vi.fn(async () => undefined),
    deleteGmailSyncState: vi.fn(async () => undefined),
    upsertGmailSyncState,
    publishGmailSeed,
  };
  const domain = new GmailDomain(
    {
      runtime: {
        getService: (name: string) => (name === "google" ? google : null),
      },
      agentId: () => "agent-1",
      repository,
      recordConnectorAudit: vi.fn(async () => undefined),
    } as never,
    {
      requireGoogleGmailGrant: vi.fn(async () => grant),
      requireGoogleGmailSendGrant: vi.fn(async () => grant),
    } as never,
  );
  return { domain, google, repository };
}

describe("LifeOps Gmail sync cursors", () => {
  it("captures a provider history cursor before the bounded initial seed", async () => {
    const { domain, google, repository } = harness({});

    const feed = await domain.getGmailTriage(new URL("http://127.0.0.1/"));

    expect(feed.messages).toHaveLength(1);
    expect(google.getGmailHistoryId).toHaveBeenCalledBefore(
      google.searchGmailMessages,
    );
    expect(repository.upsertGmailSyncState).toHaveBeenCalledWith(
      expect.objectContaining({ historyId: "100", cursorStatus: "seeded" }),
    );
  });

  it("applies history tombstones and advances the cursor only after provider changes", async () => {
    const listHistory = vi
      .fn()
      .mockResolvedValueOnce({
        historyId: "104",
        nextPageToken: "page-2",
        changes: [
          {
            historyId: "104",
            messagesAdded: [
              { messageId: "new", threadId: "thread-new", labelIds: [] },
            ],
            messagesDeleted: [],
            labelsAdded: [],
            labelsRemoved: [],
          },
        ],
      })
      .mockResolvedValueOnce({
        historyId: "105",
        nextPageToken: null,
        changes: [
          {
            historyId: "105",
            messagesAdded: [],
            messagesDeleted: [
              { messageId: "gone", threadId: "thread-gone", labelIds: [] },
            ],
            labelsAdded: [],
            labelsRemoved: [],
          },
        ],
      });
    const { domain, repository } = harness({
      previousState: { historyId: "100" },
      listHistory,
    });

    await domain.getGmailTriage(new URL("http://127.0.0.1/"));

    expect(listHistory).toHaveBeenNthCalledWith(2, {
      accountId: "account-1",
      startHistoryId: "100",
      pageToken: "page-2",
    });
    // Tombstones match on the provider message id so rows written under the
    // pre-account-scoped projection id are deleted as well.
    expect(repository.deleteGmailMessagesByExternalId).toHaveBeenCalledWith(
      "agent-1",
      "google",
      ["gone"],
      "owner",
      grant.id,
    );
    expect(repository.deleteGmailMessages).not.toHaveBeenCalled();
    expect(repository.upsertGmailSyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        historyId: "105",
        cursorStatus: "incremental",
      }),
    );
  });

  it("requires an explicit complete seed when the cursor expires", async () => {
    const listHistory = vi.fn(async () => {
      throw { code: "GOOGLE_GMAIL_HISTORY_CURSOR_EXPIRED" };
    });
    const { domain, repository } = harness({
      previousState: { historyId: "expired" },
      listHistory,
      historyId: "200",
    });

    await expect(
      domain.getGmailTriage(new URL("http://127.0.0.1/")),
    ).rejects.toMatchObject({
      status: 409,
      code: "LIFEOPS_GMAIL_RESYNC_REQUIRED",
    });

    expect(repository.upsertGmailSyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        historyId: null,
        cursorStatus: "resynced",
        fullResyncReason: "history_cursor_expired",
      }),
    );
  });

  it("reports exact local cursor and cache health for one connected account", async () => {
    const { domain } = harness({
      previousState: {
        historyId: "105",
        cursorStatus: "incremental",
        fullResyncReason: null,
        syncedAt: "2026-08-22T08:00:00.000Z",
      },
    });

    await expect(
      domain.getGmailSyncHealth(new URL("http://127.0.0.1/"), {
        grantId: grant.id,
      }),
    ).resolves.toEqual({
      provider: "google",
      side: "owner",
      grantId: grant.id,
      connectorAccountId: "account-1",
      mailbox: "me",
      state: "current",
      cursorStatus: "incremental",
      historyCursorPresent: true,
      fullResyncReason: null,
      cachedMessageCount: 4,
      syncedAt: "2026-08-22T08:00:00.000Z",
    });
  });

  it("keeps expired-history recovery blocked until a complete seed publishes", async () => {
    const { domain, google } = harness({
      previousState: {
        historyId: null,
        cursorStatus: "resynced",
        fullResyncReason: "history_cursor_expired",
        syncedAt: "2026-08-22T08:00:00.000Z",
      },
    });

    await expect(
      domain.getGmailTriage(new URL("http://127.0.0.1/")),
    ).rejects.toMatchObject({
      status: 409,
      code: "LIFEOPS_GMAIL_RESYNC_REQUIRED",
    });
    expect(google.getGmailHistoryId).not.toHaveBeenCalled();
    expect(google.searchGmailMessages).not.toHaveBeenCalled();
  });

  it("reports expired History as resync required rather than current", async () => {
    const { domain } = harness({
      previousState: {
        historyId: null,
        cursorStatus: "resynced",
        fullResyncReason: "history_cursor_expired",
        syncedAt: "2026-08-22T08:00:00.000Z",
      },
    });

    await expect(
      domain.getGmailSyncHealth(new URL("http://127.0.0.1/"), {
        grantId: grant.id,
      }),
    ).resolves.toMatchObject({
      state: "resync_required",
      historyCursorPresent: false,
      fullResyncReason: "history_cursor_expired",
    });
  });
});

describe("LifeOps Gmail range seed", () => {
  const url = new URL("http://127.0.0.1/");

  it("walks every provider page for the range and reports the complete count", async () => {
    const pageOne = Array.from({ length: 100 }, (_, index) =>
      providerMessage(`p1-${index}`),
    );
    const pageTwo = Array.from({ length: 37 }, (_, index) =>
      providerMessage(`p2-${index}`),
    );
    const searchPages = vi
      .fn()
      .mockResolvedValueOnce({ messages: pageOne, nextPageToken: "page-2" })
      .mockResolvedValueOnce({ messages: pageTwo, nextPageToken: null });
    const { domain, google, repository } = harness({
      searchPages,
      historyId: "300",
    });

    const receipt = await domain.seedGmailMessages(
      url,
      { grantId: grant.id, rangeDays: 30 },
      new Date("2026-08-22T10:00:00.000Z"),
    );

    expect(receipt).toEqual({
      provider: "google",
      side: "owner",
      grantId: grant.id,
      connectorAccountId: "account-1",
      rangeDays: 30,
      query: "newer_than:30d",
      messageCount: 137,
      pageCount: 2,
      historyCursorPresent: true,
      seededAt: "2026-08-22T10:00:00.000Z",
    });
    expect(searchPages).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        accountId: "account-1",
        query: "newer_than:30d",
        pageToken: null,
        pageSize: 100,
      }),
    );
    expect(searchPages).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ pageToken: "page-2" }),
    );
    expect(repository.publishGmailSeed).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ externalId: "p1-0" }),
        expect.objectContaining({ externalId: "p2-36" }),
      ]),
      expect.objectContaining({
        historyId: "300",
        cursorStatus: "seeded",
        maxResults: 137,
      }),
    );
    expect(repository.upsertGmailMessage).not.toHaveBeenCalled();
    expect(google.getGmailHistoryId).toHaveBeenCalledBefore(searchPages);
    expect(repository.upsertGmailSyncState).not.toHaveBeenCalled();
  });

  it("aborts without a receipt or cursor when the provider repeats a page token", async () => {
    let page = 0;
    const searchPages = vi.fn(async () => {
      page += 1;
      return {
        messages: [providerMessage(`loop-${page}`)],
        nextPageToken: "same-token",
      };
    });
    const { domain, repository } = harness({ searchPages });

    await expect(
      domain.seedGmailMessages(url, { grantId: grant.id, rangeDays: 7 }),
    ).rejects.toMatchObject({
      status: 502,
      code: "LIFEOPS_GMAIL_SEED_PAGINATION_REPEATED",
    });
    expect(searchPages).toHaveBeenCalledTimes(2);
    expect(repository.upsertGmailSyncState).not.toHaveBeenCalled();
    expect(repository.publishGmailSeed).not.toHaveBeenCalled();
    expect(repository.upsertGmailMessage).not.toHaveBeenCalled();
  });

  it("fails explicitly instead of issuing a receipt when pagination never ends", async () => {
    let page = 0;
    const searchPages = vi.fn(async () => {
      page += 1;
      return { messages: [], nextPageToken: `token-${page}` };
    });
    const { domain, repository } = harness({ searchPages });

    await expect(
      domain.seedGmailMessages(url, { grantId: grant.id, rangeDays: 90 }),
    ).rejects.toMatchObject({
      status: 409,
      code: "LIFEOPS_GMAIL_SEED_INCOMPLETE",
    });
    expect(searchPages).toHaveBeenCalledTimes(500);
    expect(repository.upsertGmailSyncState).not.toHaveBeenCalled();
    expect(repository.publishGmailSeed).not.toHaveBeenCalled();
    expect(repository.upsertGmailMessage).not.toHaveBeenCalled();
  });

  it("rejects a repeated provider message before publishing any projection", async () => {
    const searchPages = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [providerMessage("duplicate")],
        nextPageToken: "page-2",
      })
      .mockResolvedValueOnce({
        messages: [providerMessage("duplicate")],
        nextPageToken: null,
      });
    const { domain, repository } = harness({ searchPages });

    await expect(
      domain.seedGmailMessages(url, { grantId: grant.id, rangeDays: 30 }),
    ).rejects.toMatchObject({
      status: 502,
      code: "LIFEOPS_GMAIL_SEED_DUPLICATE_MESSAGE",
    });
    expect(repository.publishGmailSeed).not.toHaveBeenCalled();
    expect(repository.upsertGmailMessage).not.toHaveBeenCalled();
  });

  it("rejects a range outside the owner-selectable 7/30/90-day windows", async () => {
    const { domain, google } = harness({});

    await expect(
      domain.seedGmailMessages(url, {
        grantId: grant.id,
        rangeDays: 45 as never,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(google.searchGmailMessagesPage).not.toHaveBeenCalled();
  });
});

describe("LifeOps Gmail imported-data purge", () => {
  it("requires immediate confirmation and exact grant/account identity", async () => {
    const { domain, repository } = harness({});
    const request = {
      grantId: grant.id,
      connectorAccountId: "account-1",
      confirmAction: false,
    };

    await expect(
      domain.purgeGmailImportedData(new URL("http://127.0.0.1/"), request),
    ).rejects.toThrow(/explicit confirmation/i);
    await expect(
      domain.purgeGmailImportedData(new URL("http://127.0.0.1/"), {
        ...request,
        connectorAccountId: "different-account",
        confirmAction: true,
      }),
    ).rejects.toThrow(/identities do not match/i);
    expect(repository.deleteGmailMessagesForProvider).not.toHaveBeenCalled();
  });

  it("purges only the local exact-grant projection and returns honest counts", async () => {
    const { domain, repository } = harness({
      previousState: { historyId: "105" },
    });

    const receipt = await domain.purgeGmailImportedData(
      new URL("http://127.0.0.1/"),
      {
        grantId: grant.id,
        connectorAccountId: "account-1",
        confirmAction: true,
      },
      new Date("2026-08-22T09:00:00.000Z"),
    );

    expect(receipt).toEqual({
      provider: "google",
      side: "owner",
      grantId: grant.id,
      connectorAccountId: "account-1",
      deletedMessageCount: 4,
      deletedSpamReviewCount: 2,
      deletedSyncCursor: true,
      providerMutation: false,
      purgedAt: "2026-08-22T09:00:00.000Z",
    });
    expect(repository.deleteGmailMessagesForProvider).toHaveBeenCalledWith(
      "agent-1",
      "google",
      "owner",
      grant.id,
    );
    expect(
      repository.deleteGmailSpamReviewItemsForProvider,
    ).toHaveBeenCalledWith("agent-1", "google", "owner", grant.id);
    expect(repository.deleteGmailSyncState).toHaveBeenCalledWith(
      "agent-1",
      "google",
      "me",
      "owner",
      grant.id,
    );
  });
});

describe("LifeOps Gmail effect confirmation", () => {
  it("rejects a destructive execute request without immediate confirmation", async () => {
    const { domain, google } = harness({});

    await expect(
      domain.manageGmailMessages(new URL("http://127.0.0.1/"), {
        operation: "trash",
        messageIds: ["message-1"],
        executionMode: "execute",
      }),
    ).rejects.toThrow(/explicit destructive confirmation/i);
    expect(google.modifyGmailMessages).not.toHaveBeenCalled();
  });

  it("executes a non-destructive operation without a confirmation flag", async () => {
    const { domain, google } = harness({});
    google.modifyGmailMessages.mockResolvedValueOnce({
      operation: "archive",
      requestedMessageIds: ["message-1"],
      succeededMessageIds: ["message-1"],
      failures: [],
    });

    const result = await domain.manageGmailMessages(
      new URL("http://127.0.0.1/"),
      {
        operation: "archive",
        messageIds: ["message-1"],
        executionMode: "execute",
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: "executed",
      affectedCount: 1,
    });
    expect(google.modifyGmailMessages).toHaveBeenCalledOnce();
  });

  it("returns an honest partial receipt and only updates succeeded messages", async () => {
    const { domain, repository } = harness({});

    const result = await domain.manageGmailMessages(
      new URL("http://127.0.0.1/"),
      {
        operation: "trash",
        messageIds: ["message-1", "message-2"],
        executionMode: "execute",
        confirmAction: true,
      },
    );

    expect(result).toMatchObject({
      ok: true,
      status: "partial",
      affectedCount: 1,
      providerReceipt: {
        succeededMessageIds: ["message-1"],
        failures: [{ messageId: "message-2", code: 429, retryable: true }],
      },
    });
    expect(repository.upsertGmailMessage).toHaveBeenCalledTimes(1);
  });
});

describe("LifeOps Gmail provider draft", () => {
  it("persists an unsent reply draft and exposes the provider receipt", async () => {
    const { domain, google } = harness({});

    const draft = await domain.createGmailReplyDraft(
      new URL("http://127.0.0.1/"),
      {
        messageId: "message-1",
        persistToProvider: true,
      },
    );

    expect(draft).toMatchObject({
      providerDraftId: "draft-1",
      providerDraftMessageId: "draft-message-1",
      persistence: "gmail_draft",
      requiresConfirmation: true,
    });
    expect(google.createGmailDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-1",
        threadId: "thread-message-1",
        inReplyTo: "<provider-message@example.com>",
        references: "<earlier-message@example.com>",
      }),
    );
  });
});
