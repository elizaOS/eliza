import { afterEach, describe, expect, it } from "vitest";
import { type StartedMocks, startMocks } from "../scripts/start-mocks.ts";

type LabelsResponse = {
  labels?: Array<{ id?: string; name?: string; type?: string }>;
};

type MessageResponse = {
  id?: string;
  threadId?: string;
  labelIds?: string[];
};

type MessagesResponse = {
  messages?: Array<{ id?: string; threadId?: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
};

type ProfileResponse = {
  emailAddress?: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
};

type DraftResponse = {
  id?: string;
  message?: MessageResponse;
};

type DraftsResponse = {
  drafts?: DraftResponse[];
  resultSizeEstimate?: number;
};

type WatchResponse = {
  historyId?: string;
  expiration?: string;
};

type HistoryResponse = {
  history?: Array<{
    id?: string;
    labelsAdded?: Array<{ message?: { id?: string }; labelIds?: string[] }>;
    labelsRemoved?: Array<{ message?: { id?: string }; labelIds?: string[] }>;
    messagesAdded?: Array<{ message?: { id?: string } }>;
    messagesDeleted?: Array<{ message?: { id?: string } }>;
  }>;
  historyId?: string;
};

type ThreadsResponse = {
  threads?: Array<{ id?: string }>;
  resultSizeEstimate?: number;
};

type ThreadResponse = {
  id?: string;
  messages?: MessageResponse[];
};

async function readJson<T>(response: Response): Promise<T> {
  expect(response.headers.get("content-type")).toContain("application/json");
  return (await response.json()) as T;
}

function rawEmail(
  headers: Record<string, string>,
  body = "Synthetic Gmail mock body.",
): string {
  return Buffer.from(
    [
      ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`),
      "",
      body,
    ].join("\r\n"),
    "utf8",
  ).toString("base64url");
}

async function messageIds(
  baseUrl: string,
  query: string,
  init?: RequestInit,
): Promise<string[]> {
  const response = await fetch(
    `${baseUrl}/gmail/v1/users/me/messages?${query}`,
    init,
  );
  expect(response.status).toBe(200);
  const body = await readJson<MessagesResponse>(response);
  return body.messages?.map((message) => message.id ?? "") ?? [];
}

describe("Google mock Gmail fidelity surface", () => {
  let mocks: StartedMocks | null = null;

  afterEach(async () => {
    await mocks?.stop();
    mocks = null;
  });

  it("covers Gmail control-plane list/get/labels/thread/watch/history endpoints", async () => {
    mocks = await startMocks({ envs: ["google"] });
    const baseUrl = mocks.baseUrls.google;

    const labelsResponse = await fetch(`${baseUrl}/gmail/v1/users/me/labels`);
    expect(labelsResponse.status).toBe(200);
    const labels = await readJson<LabelsResponse>(labelsResponse);
    expect(labels.labels?.map((label) => label.id)).toEqual(
      expect.arrayContaining(["INBOX", "SENT", "DRAFT", "SPAM", "TRASH"]),
    );
    expect(
      labels.labels?.find((label) => label.name === "eliza-e2e")?.type,
    ).toBe("user");

    const inboxList = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=2`,
    );
    expect(inboxList.status).toBe(200);
    const inboxBody = await readJson<MessagesResponse>(inboxList);
    expect(inboxBody.messages?.length).toBe(2);
    expect(inboxBody.nextPageToken).toBe("2");

    expect(
      await messageIds(baseUrl, "q=in%3Aspam&includeSpamTrash=true"),
    ).toContain("msg-spam");
    expect(
      await messageIds(baseUrl, "q=in%3Asent%20older_than%3A3d"),
    ).toContain("msg-unresponded-sent");

    const missingMessage = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/not-real`,
    );
    expect(missingMessage.status).toBe(404);

    const watch = await fetch(`${baseUrl}/gmail/v1/users/me/watch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Eliza-Test-Run": "run-control-plane",
      },
      body: JSON.stringify({
        labelIds: ["INBOX"],
        labelFilterBehavior: "include",
        topicName: "projects/eliza-e2e/topics/gmail",
      }),
    });
    expect(watch.status).toBe(200);
    const watchBody = await readJson<WatchResponse>(watch);
    expect(watchBody.historyId).toBe("123456");
    expect(Number(watchBody.expiration)).toBeGreaterThan(Date.now());

    const history = await fetch(
      `${baseUrl}/gmail/v1/users/me/history?startHistoryId=0`,
    );
    expect(history.status).toBe(200);
    const historyBody = await readJson<HistoryResponse>(history);
    expect(historyBody.history?.[0]?.id).toBe("123456");

    const threads = await fetch(`${baseUrl}/gmail/v1/users/me/threads`);
    expect(threads.status).toBe(200);
    expect((await readJson<ThreadsResponse>(threads)).resultSizeEstimate).toBe(
      9,
    );

    const thread = await fetch(
      `${baseUrl}/gmail/v1/users/me/threads/thr-unresponded`,
    );
    expect(thread.status).toBe(200);
    const threadBody = await readJson<ThreadResponse>(thread);
    expect(threadBody.id).toBe("thr-unresponded");
    expect(threadBody.messages?.map((message) => message.id)).toEqual(
      expect.arrayContaining([
        "msg-unresponded-inbound",
        "msg-unresponded-sent",
      ]),
    );
  });

  it("supports work, home, all-account, vague, multi-search, and priority Gmail queries", async () => {
    mocks = await startMocks({ envs: ["google"] });
    const baseUrl = mocks.baseUrls.google;

    expect(
      await messageIds(
        baseUrl,
        new URLSearchParams({ account: "work", q: "invoice" }).toString(),
      ),
    ).toEqual(["msg-finance"]);
    expect(
      await messageIds(
        baseUrl,
        new URLSearchParams({ account: "home", q: "lease" }).toString(),
      ),
    ).toEqual(["msg-home-lease"]);
    expect(
      await messageIds(
        baseUrl,
        new URLSearchParams({
          account: "all",
          q: "lease OR invoice",
        }).toString(),
      ),
    ).toEqual(expect.arrayContaining(["msg-home-lease", "msg-finance"]));

    expect(
      await messageIds(
        baseUrl,
        new URLSearchParams({ account: "all", q: "review" }).toString(),
      ),
    ).toEqual(expect.arrayContaining(["msg-sarah", "msg-newsletter"]));
    expect(
      await messageIds(
        baseUrl,
        new URLSearchParams({
          account: "all",
          q: "{dentist invoice}",
        }).toString(),
      ),
    ).toEqual(expect.arrayContaining(["msg-home-dentist", "msg-finance"]));

    expect(
      await messageIds(
        baseUrl,
        new URLSearchParams({ account: "all", q: "priority" }).toString(),
      ),
    ).toEqual(expect.arrayContaining(["msg-finance", "msg-home-lease"]));
    expect(
      await messageIds(
        baseUrl,
        new URLSearchParams({ account: "all", q: "is:important" }).toString(),
      ),
    ).toEqual(expect.arrayContaining(["msg-finance", "msg-home-lease"]));
    expect(
      await messageIds(
        baseUrl,
        new URLSearchParams({ account: "all", q: "unread" }).toString(),
      ),
    ).toEqual(
      expect.arrayContaining([
        "msg-finance",
        "msg-sarah",
        "msg-home-lease",
        "msg-home-dentist",
      ]),
    );

    const needsResponse = await messageIds(
      baseUrl,
      new URLSearchParams({ account: "all", q: "needs-response" }).toString(),
    );
    expect(needsResponse).toEqual(
      expect.arrayContaining(["msg-finance", "msg-sarah", "msg-home-lease"]),
    );
    expect(needsResponse).not.toContain("msg-home-dentist");

    const tokenResponse = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        scope:
          "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly",
        grantId: "mock-google-home-grant",
      }),
    });
    const token = (await readJson<{ access_token?: string }>(tokenResponse))
      .access_token;
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    const profile = await fetch(`${baseUrl}/gmail/v1/users/me/profile`, auth);
    expect(profile.status).toBe(200);
    expect((await readJson<ProfileResponse>(profile)).emailAddress).toBe(
      "owner.home@example.test",
    );
    expect(
      await messageIds(
        baseUrl,
        new URLSearchParams({ q: "lease" }).toString(),
        auth,
      ),
    ).toEqual(["msg-home-lease"]);
    expect(
      await messageIds(
        baseUrl,
        new URLSearchParams({ q: "invoice" }).toString(),
        auth,
      ),
    ).toEqual([]);

    const calendar = await fetch(
      `${baseUrl}/calendar/v3/users/me/calendarList`,
      auth,
    );
    expect(calendar.status).toBe(200);
  });

  it("persists archive, unarchive, read, unread, and spam label writes", async () => {
    mocks = await startMocks({ envs: ["google"] });
    const baseUrl = mocks.baseUrls.google;

    expect(await messageIds(baseUrl, "labelIds=INBOX")).toContain(
      "msg-finance",
    );

    const archive = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/batchModify`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Eliza-Test-Run": "run-labels",
        },
        body: JSON.stringify({
          ids: ["msg-finance"],
          removeLabelIds: ["INBOX"],
        }),
      },
    );
    expect(archive.status).toBe(200);
    expect(await messageIds(baseUrl, "labelIds=INBOX")).not.toContain(
      "msg-finance",
    );

    const unarchive = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/msg-finance/modify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ addLabelIds: ["INBOX"] }),
      },
    );
    expect(unarchive.status).toBe(200);
    expect((await readJson<MessageResponse>(unarchive)).labelIds).toContain(
      "INBOX",
    );

    const markRead = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/batchModify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: ["msg-sarah"],
          removeLabelIds: ["UNREAD"],
        }),
      },
    );
    expect(markRead.status).toBe(200);
    expect(
      (
        await fetch(`${baseUrl}/gmail/v1/users/me/messages/msg-sarah`).then(
          (response) => readJson<MessageResponse>(response),
        )
      ).labelIds,
    ).not.toContain("UNREAD");

    const markUnread = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/batchModify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["msg-sarah"], addLabelIds: ["UNREAD"] }),
      },
    );
    expect(markUnread.status).toBe(200);
    expect(
      (
        await fetch(`${baseUrl}/gmail/v1/users/me/messages/msg-sarah`).then(
          (response) => readJson<MessageResponse>(response),
        )
      ).labelIds,
    ).toContain("UNREAD");

    const spam = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/batchModify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: ["msg-newsletter"],
          addLabelIds: ["SPAM"],
          removeLabelIds: ["INBOX"],
        }),
      },
    );
    expect(spam.status).toBe(200);
    expect(
      await messageIds(baseUrl, "q=in%3Aspam&includeSpamTrash=true"),
    ).toContain("msg-newsletter");

    expect(mocks.requestLedger()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-labels",
          gmail: expect.objectContaining({
            action: "messages.batchModify",
            batchIds: ["msg-finance"],
            removeLabelIds: ["INBOX"],
          }),
        }),
      ]),
    );
  });

  it("persists trash, untrash, hard delete, and batch delete", async () => {
    mocks = await startMocks({ envs: ["google"] });
    const baseUrl = mocks.baseUrls.google;

    const trashed = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/msg-finance/trash`,
      { method: "POST" },
    );
    expect(trashed.status).toBe(200);
    expect((await readJson<MessageResponse>(trashed)).labelIds).toContain(
      "TRASH",
    );
    expect(await messageIds(baseUrl, "labelIds=INBOX")).not.toContain(
      "msg-finance",
    );

    const untrashed = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/msg-finance/untrash`,
      { method: "POST" },
    );
    expect(untrashed.status).toBe(200);
    expect((await readJson<MessageResponse>(untrashed)).labelIds).toContain(
      "INBOX",
    );

    const batchDelete = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/batchDelete`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["msg-newsletter"] }),
      },
    );
    expect(batchDelete.status).toBe(200);
    expect(
      await fetch(`${baseUrl}/gmail/v1/users/me/messages/msg-newsletter`),
    ).toHaveProperty("status", 404);

    const deleted = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/msg-julia`,
      { method: "DELETE" },
    );
    expect(deleted.status).toBe(200);
    expect(
      await fetch(`${baseUrl}/gmail/v1/users/me/messages/msg-julia`),
    ).toHaveProperty("status", 404);
  });

  it("persists draft create, get, list, send, and delete", async () => {
    mocks = await startMocks({ envs: ["google"] });
    const baseUrl = mocks.baseUrls.google;

    const initialDrafts = await fetch(`${baseUrl}/gmail/v1/users/me/drafts`);
    expect(
      (await readJson<DraftsResponse>(initialDrafts)).resultSizeEstimate,
    ).toBe(1);

    const createdDraft = await fetch(`${baseUrl}/gmail/v1/users/me/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          raw: rawEmail({
            To: "approver@example.test",
            Subject: "Draft lifecycle",
          }),
        },
      }),
    });
    expect(createdDraft.status).toBe(200);
    const draft = await readJson<DraftResponse>(createdDraft);
    expect(draft.id?.startsWith("draft-")).toBe(true);
    expect(draft.message?.labelIds).toContain("DRAFT");

    const draftList = await fetch(`${baseUrl}/gmail/v1/users/me/drafts`);
    expect((await readJson<DraftsResponse>(draftList)).resultSizeEstimate).toBe(
      2,
    );

    const readDraft = await fetch(
      `${baseUrl}/gmail/v1/users/me/drafts/${draft.id}`,
    );
    expect(readDraft.status).toBe(200);
    expect((await readJson<DraftResponse>(readDraft)).id).toBe(draft.id);

    const deletedDraft = await fetch(
      `${baseUrl}/gmail/v1/users/me/drafts/${draft.id}`,
      { method: "DELETE" },
    );
    expect(deletedDraft.status).toBe(200);

    const sendableDraft = await fetch(`${baseUrl}/gmail/v1/users/me/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          raw: rawEmail({
            To: "send@example.test",
            Subject: "Send this draft",
          }),
        },
      }),
    }).then((response) => readJson<DraftResponse>(response));

    const sentDraft = await fetch(`${baseUrl}/gmail/v1/users/me/drafts/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: sendableDraft.id }),
    });
    expect(sentDraft.status).toBe(200);
    const sentMessage = await readJson<MessageResponse>(sentDraft);
    expect(sentMessage.labelIds).toContain("SENT");
    expect(await messageIds(baseUrl, "q=in%3Asent")).toContain(sentMessage.id);
    expect(
      await fetch(`${baseUrl}/gmail/v1/users/me/drafts/${sendableDraft.id}`),
    ).toHaveProperty("status", 404);

    expect(mocks.requestLedger()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gmail: expect.objectContaining({
            action: "drafts.send",
            draftId: sendableDraft.id,
            messageId: sentMessage.id,
          }),
        }),
      ]),
    );
  });

  it("records decoded send metadata and run IDs in the request ledger", async () => {
    mocks = await startMocks({ envs: ["google"] });
    const baseUrl = mocks.baseUrls.google;
    const raw = rawEmail(
      {
        From: "Owner <owner@example.test>",
        To: "Recipient <recipient@example.test>",
        Cc: "Reviewer <reviewer@example.test>",
        Bcc: "Audit <audit@example.test>",
        Subject: "Ledger proof",
        "X-Eliza-Test-Run": "run-raw-header",
      },
      "This send should be decoded into structured metadata.",
    );

    const sent = await fetch(`${baseUrl}/gmail/v1/users/me/messages/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Eliza-Run-Id": "run-request-header",
      },
      body: JSON.stringify({ raw }),
    });
    expect(sent.status).toBe(200);
    const sentBody = await readJson<MessageResponse>(sent);

    expect(mocks.requestLedger()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: "run-request-header",
          gmail: expect.objectContaining({
            action: "messages.send",
            messageId: sentBody.id,
            runId: "run-raw-header",
            decodedSend: expect.objectContaining({
              to: ["Recipient <recipient@example.test>"],
              cc: ["Reviewer <reviewer@example.test>"],
              bcc: ["Audit <audit@example.test>"],
              subject: "Ledger proof",
              runIdHeader: "run-raw-header",
              bodyText: "This send should be decoded into structured metadata.",
            }),
          }),
        }),
      ]),
    );
  });

  it("fails malformed write payloads and enforces inferred token scopes", async () => {
    mocks = await startMocks({ envs: ["google"] });
    const baseUrl = mocks.baseUrls.google;

    const malformedModify = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/batchModify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: ["msg-finance"] }),
      },
    );
    expect(malformedModify.status).toBe(400);

    const malformedSend = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/send`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: "not valid base64***" }),
      },
    );
    expect(malformedSend.status).toBe(400);

    const unknownToken = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/batchModify`,
      {
        method: "POST",
        headers: {
          Authorization: "Bearer not-known",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ids: ["msg-finance"],
          removeLabelIds: ["INBOX"],
        }),
      },
    );
    expect(unknownToken.status).toBe(401);

    const tokenResponse = await fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        scope: "https://www.googleapis.com/auth/gmail.readonly",
      }),
    });
    const readonlyToken = (
      await readJson<{ access_token?: string }>(tokenResponse)
    ).access_token;

    const forbiddenWrite = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/batchModify`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${readonlyToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ids: ["msg-finance"],
          removeLabelIds: ["INBOX"],
        }),
      },
    );
    expect(forbiddenWrite.status).toBe(403);

    const allowedRead = await fetch(`${baseUrl}/gmail/v1/users/me/messages`, {
      headers: { Authorization: `Bearer ${readonlyToken}` },
    });
    expect(allowedRead.status).toBe(200);
  });

  it("updates pagination and history after mutations", async () => {
    mocks = await startMocks({ envs: ["google"] });
    const baseUrl = mocks.baseUrls.google;

    const watch = await fetch(`${baseUrl}/gmail/v1/users/me/watch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        labelIds: ["INBOX"],
        topicName: "projects/eliza-e2e/topics/gmail",
      }),
    });
    const startHistoryId = (await readJson<WatchResponse>(watch)).historyId;

    const firstPage = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages?account=work&labelIds=INBOX&maxResults=2`,
    );
    expect((await readJson<MessagesResponse>(firstPage)).nextPageToken).toBe(
      "2",
    );

    const archiveTwo = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages/batchModify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ids: ["msg-finance", "msg-newsletter", "msg-unresponded-inbound"],
          removeLabelIds: ["INBOX"],
        }),
      },
    );
    expect(archiveTwo.status).toBe(200);

    const pageAfterMutation = await fetch(
      `${baseUrl}/gmail/v1/users/me/messages?account=work&labelIds=INBOX&maxResults=2`,
    );
    const pageAfterMutationBody =
      await readJson<MessagesResponse>(pageAfterMutation);
    expect(
      pageAfterMutationBody.messages?.map((message) => message.id),
    ).toEqual(["msg-sarah", "msg-julia"]);
    expect(pageAfterMutationBody.nextPageToken).toBeUndefined();

    const history = await fetch(
      `${baseUrl}/gmail/v1/users/me/history?startHistoryId=${startHistoryId}`,
    );
    const historyBody = await readJson<HistoryResponse>(history);
    expect(
      historyBody.history?.flatMap((entry) => entry.labelsRemoved ?? []),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: { id: "msg-finance", threadId: "thr-finance" },
          labelIds: ["INBOX"],
        }),
        expect.objectContaining({
          message: { id: "msg-newsletter", threadId: "thr-news" },
          labelIds: ["INBOX"],
        }),
      ]),
    );
    expect(Number(historyBody.historyId)).toBeGreaterThan(
      Number(startHistoryId),
    );
  });

  it("persists thread-level modify, trash, and untrash operations", async () => {
    mocks = await startMocks({ envs: ["google"] });
    const baseUrl = mocks.baseUrls.google;

    const modifiedThread = await fetch(
      `${baseUrl}/gmail/v1/users/me/threads/thr-finance/modify`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ removeLabelIds: ["UNREAD"] }),
      },
    );
    expect(modifiedThread.status).toBe(200);
    expect(
      (await readJson<ThreadResponse>(modifiedThread)).messages?.[0]?.labelIds,
    ).not.toContain("UNREAD");

    const trashedThread = await fetch(
      `${baseUrl}/gmail/v1/users/me/threads/thr-finance/trash`,
      { method: "POST" },
    );
    expect(trashedThread.status).toBe(200);
    expect(
      (await readJson<ThreadResponse>(trashedThread)).messages?.[0]?.labelIds,
    ).toContain("TRASH");

    const untrashedThread = await fetch(
      `${baseUrl}/gmail/v1/users/me/threads/thr-finance/untrash`,
      { method: "POST" },
    );
    expect(untrashedThread.status).toBe(200);
    expect(
      (await readJson<ThreadResponse>(untrashedThread)).messages?.[0]?.labelIds,
    ).toContain("INBOX");
  });

  it("keeps settings filter creation reachable for unsubscribe flows", async () => {
    mocks = await startMocks({ envs: ["google"] });
    const baseUrl = mocks.baseUrls.google;

    const filter = await fetch(
      `${baseUrl}/gmail/v1/users/me/settings/filters`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          criteria: { from: "digest@example.com" },
          action: { removeLabelIds: ["INBOX"] },
        }),
      },
    );
    expect(filter.status).toBe(200);
    const filterBody = await readJson<{ id?: string }>(filter);
    expect((filterBody.id ?? "").startsWith("filter-")).toBe(true);
  });
});
