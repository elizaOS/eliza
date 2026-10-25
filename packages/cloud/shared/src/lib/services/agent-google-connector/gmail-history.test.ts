import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { fetchManagedGoogleGmailHistory } from "./gmail-history";
import { managedGoogleConnectorDeps } from "./shared";

const savedFetch = globalThis.fetch,
  savedDeps = { ...managedGoogleConnectorDeps };
const env = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
};
const input = {
  organizationId: "org-1",
  userId: "owner-1",
  grantId: "grant-1",
  startHistoryId: "100",
};
let tokenChanged: (() => void) | undefined;
let state = "active",
  scopes: string[],
  calls: string[],
  response: () => Promise<Response>,
  metadataResponse: (id: string) => Promise<Response>;
const event = (id = "101") => ({
  id,
  messagesAdded: [{ message: { id: "message-1", threadId: "thread-1" } }],
});
beforeEach(() => {
  tokenChanged = undefined;
  state = "active";
  scopes = ["https://www.googleapis.com/auth/gmail.readonly"];
  calls = [];
  process.env.GOOGLE_CLIENT_ID = "fixture";
  process.env.GOOGLE_CLIENT_SECRET = "fixture";
  managedGoogleConnectorDeps.oauthService = {
    ...savedDeps.oauthService,
    listConnections: async (scope: {
      organizationId: string;
      userId: string;
      connectionRole: string;
    }) =>
      scope.organizationId === input.organizationId &&
      scope.userId === input.userId &&
      scope.connectionRole === "owner"
        ? [
            {
              id: "grant-1",
              userId: "owner-1",
              connectionRole: "owner",
              status: state,
              platformUserId: "google-owner",
              email: "owner@example.com",
              scopes,
              linkedAt: new Date(0),
            },
          ]
        : [],
    getValidToken: async () => {
      tokenChanged?.();
      return { accessToken: "fixture-token" };
    },
  } as unknown as typeof savedDeps.oauthService;
  managedGoogleConnectorDeps.dbRead = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  } as unknown as typeof savedDeps.dbRead;
  response = async () => Response.json({ historyId: "120", history: [event()] });
  metadataResponse = async (id) => Response.json({ id, threadId: "thread-1", labelIds: [] });
  globalThis.fetch = mock(async (url: Parameters<typeof fetch>[0], options?: RequestInit) => {
    calls.push(String(url));
    expect(options?.method ?? "GET").toBe("GET");
    const path = new URL(String(url)).pathname;
    return path.includes("/messages/") ? metadataResponse(path.split("/").at(-1)!) : response();
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  Object.assign(managedGoogleConnectorDeps, savedDeps);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  mock.restore();
});
test("owner grant returns stable events and a final checkpoint without provider mutation", async () => {
  const page = await fetchManagedGoogleGmailHistory(input);
  expect(page).toMatchObject({
    status: "page",
    historyId: "120",
    checkpoint: "120",
    nextPageToken: null,
    backfillRequired: false,
  });
  expect(page.events).toEqual([
    {
      id: "101:message-added:message-1",
      historyId: "101",
      type: "message-added",
      messageId: "message-1",
      threadId: "thread-1",
      labelIds: [],
      messageAvailable: true,
    },
  ]);
  expect(await fetchManagedGoogleGmailHistory(input)).toEqual(page);
  expect(
    calls
      .filter((url) => new URL(url).pathname.endsWith("/history"))
      .every((url) => new URL(url).searchParams.get("startHistoryId") === "100"),
  ).toBe(true);
});
test("message events preserve mailbox labels and label changes preserve only changed labels", async () => {
  metadataResponse = async (id) =>
    Response.json({
      id,
      threadId: id === "incoming" ? "thread-1" : "thread-2",
      labelIds: id === "incoming" ? ["INBOX", "UNREAD"] : ["SENT"],
    });
  response = async () =>
    Response.json({
      historyId: "120",
      history: [
        {
          id: "101",
          messagesAdded: [
            { message: { id: "incoming", threadId: "thread-1", labelIds: ["INBOX", "UNREAD"] } },
            { message: { id: "outgoing", threadId: "thread-2", labelIds: ["SENT"] } },
          ],
          labelsRemoved: [
            {
              message: { id: "incoming", threadId: "thread-1", labelIds: ["INBOX"] },
              labelIds: ["UNREAD"],
            },
          ],
        },
      ],
    });
  expect(
    (await fetchManagedGoogleGmailHistory(input)).events.map(({ labelIds }) => labelIds),
  ).toEqual([["INBOX", "UNREAD"], ["SENT"], ["UNREAD"]]);
  response = async () =>
    Response.json({
      historyId: "120",
      history: [
        {
          id: "101",
          messagesAdded: [
            {
              message: { id: "incoming", threadId: "thread-1", labelIds: Array(101).fill("INBOX") },
            },
          ],
        },
      ],
    });
  await expect(fetchManagedGoogleGmailHistory(input)).rejects.toThrow(
    "Invalid Gmail history labels.",
  );
});
test("intermediate pages cannot advance checkpoint and baseline does not claim backfill", async () => {
  response = async () =>
    Response.json({ historyId: "120", history: [event()], nextPageToken: "second" });
  expect(await fetchManagedGoogleGmailHistory(input)).toMatchObject({
    checkpoint: null,
    nextPageToken: "second",
  });
  response = async () => Response.json({ historyId: "120" });
  expect(
    await fetchManagedGoogleGmailHistory({ ...input, startHistoryId: undefined }),
  ).toMatchObject({
    status: "baseline-required",
    checkpoint: null,
    historyId: "120",
    backfillRequired: true,
    events: [],
  });
  expect(calls.at(-1)).toContain("/profile?fields=historyId");
});
test("only provider history 404 requests full reset, never unknown grants or other provider failures", async () => {
  response = async () => Response.json({ error: { message: "Expired" } }, { status: 404 });
  expect(await fetchManagedGoogleGmailHistory(input)).toMatchObject({
    status: "reset-required",
    checkpoint: null,
    historyId: null,
    events: [],
    backfillRequired: true,
  });
  calls = [];
  await expect(
    fetchManagedGoogleGmailHistory({ ...input, grantId: "different" }),
  ).rejects.toMatchObject({ status: 404 });
  expect(calls).toHaveLength(0);
  for (const status of [401, 403, 429, 500]) {
    response = async () => new Response("provider failed", { status });
    await expect(fetchManagedGoogleGmailHistory(input)).rejects.toMatchObject({ status: 502 });
  }
});
test("tenant, owner, grant and read scope remain bound before and after provider read", async () => {
  for (const changed of [{ organizationId: "other" }, { userId: "other" }])
    await expect(fetchManagedGoogleGmailHistory({ ...input, ...changed })).rejects.toMatchObject({
      status: 404,
    });
  scopes = ["https://www.googleapis.com/auth/gmail.send"];
  await expect(fetchManagedGoogleGmailHistory(input)).rejects.toMatchObject({ status: 409 });
  expect(calls).toHaveLength(0);
  scopes = ["https://www.googleapis.com/auth/gmail.metadata"];
  response = async () => {
    state = "revoked";
    return Response.json({ historyId: "120", history: [event()] });
  };
  await expect(fetchManagedGoogleGmailHistory(input)).rejects.toMatchObject({ status: 409 });
});
test("malformed and oversized history never produce a checkpoint or truncate events", async () => {
  for (const data of [
    { historyId: 120 },
    { historyId: "99" },
    { historyId: "120", history: [event("100")] },
    { historyId: "120", history: [event("121")] },
    { historyId: "120", history: [event(), event()] },
    { historyId: "120", history: [{ id: "101", messagesAdded: [{ message: { id: "x" } }] }] },
    { historyId: "120", history: [{ id: "101", messages: [{ id: "x" }] }] },
    { historyId: "120", nextPageToken: "" },
  ]) {
    response = async () => Response.json(data);
    await expect(fetchManagedGoogleGmailHistory(input)).rejects.toMatchObject({ status: 502 });
  }
  response = async () => Response.json({ historyId: "120", padding: "x".repeat(1024 * 1024) });
  await expect(fetchManagedGoogleGmailHistory(input)).rejects.toMatchObject({ status: 502 });
  response = async () =>
    Response.json({
      historyId: "120",
      history: [
        {
          id: "101",
          messagesAdded: Array.from({ length: 2001 }, (_, i) => ({
            message: { id: `m${i}`, threadId: `t${i}` },
          })),
        },
      ],
    });
  await expect(fetchManagedGoogleGmailHistory(input)).rejects.toMatchObject({ status: 502 });
});
test("bad cursors, cycles and page sizes fail explicitly", async () => {
  for (const change of [
    { startHistoryId: "-1" },
    { startHistoryId: "001" },
    { startHistoryId: "" },
    { maxResults: 101 },
    { maxResults: 1.5 },
    { pageToken: "" },
    { startHistoryId: undefined, pageToken: "x" },
  ])
    await expect(fetchManagedGoogleGmailHistory({ ...input, ...change })).rejects.toMatchObject({
      status: 400,
    });
  expect(calls).toHaveLength(0);
  response = async () => Response.json({ historyId: "120", nextPageToken: "again" });
  await expect(
    fetchManagedGoogleGmailHistory({ ...input, pageToken: "again" }),
  ).rejects.toMatchObject({ status: 502 });
});

test("grant revocation or scope removal while token refresh awaits prevents dispatch", async () => {
  for (const change of [
    () => {
      state = "revoked";
    },
    () => {
      scopes = [];
    },
  ]) {
    state = "active";
    scopes = ["https://www.googleapis.com/auth/gmail.readonly"];
    tokenChanged = change;
    await expect(fetchManagedGoogleGmailHistory(input)).rejects.toMatchObject({ status: 409 });
  }
  expect(calls).toHaveLength(0);
});

test("continuations retain the original watermark until the final durable checkpoint", async () => {
  response = async () =>
    Response.json({ historyId: "120", history: [event()], nextPageToken: "second" });
  const first = await fetchManagedGoogleGmailHistory(input);
  response = async () => Response.json({ historyId: "125", history: [event("105")] });
  const final = await fetchManagedGoogleGmailHistory({ ...input, pageToken: first.nextPageToken! });
  expect(
    new URL(
      calls.filter((url) => new URL(url).pathname.endsWith("/history")).at(-1)!,
    ).searchParams.get("startHistoryId"),
  ).toBe("100");
  expect(final).toMatchObject({ startHistoryId: "100", checkpoint: "125", nextPageToken: null });
  expect(final.events[0].historyId).toBe("105");
});

test("identity-only additions hydrate current labels; disappearance is explicit and failures cannot checkpoint", async () => {
  metadataResponse = async (id) =>
    Response.json({ id, threadId: "thread-1", labelIds: ["INBOX", "UNREAD"] });
  expect((await fetchManagedGoogleGmailHistory(input)).events[0]).toMatchObject({
    labelIds: ["INBOX", "UNREAD"],
    messageAvailable: true,
  });
  expect(calls.at(-1)).toContain("format=minimal&fields=id,threadId,labelIds");
  metadataResponse = async () => new Response(null, { status: 404 });
  expect((await fetchManagedGoogleGmailHistory(input)).events[0]).toMatchObject({
    labelIds: [],
    messageAvailable: false,
  });
  for (const status of [403, 429, 500]) {
    metadataResponse = async () => new Response(null, { status });
    await expect(fetchManagedGoogleGmailHistory(input)).rejects.toMatchObject({ status: 502 });
  }
  metadataResponse = async () => Response.json({ id: "other", threadId: "thread-1" });
  await expect(fetchManagedGoogleGmailHistory(input)).rejects.toMatchObject({ status: 502 });
  metadataResponse = async (id) => {
    state = "revoked";
    return Response.json({ id, threadId: "thread-1", labelIds: ["INBOX"] });
  };
  await expect(fetchManagedGoogleGmailHistory(input)).rejects.toMatchObject({ status: 409 });
});
test("metadata reads are bounded before dispatch and deduplicated across revisions", async () => {
  response = async () =>
    Response.json({
      historyId: "120",
      history: [
        {
          id: "101",
          messagesAdded: Array.from({ length: 101 }, (_, i) => ({
            message: { id: `m${i}`, threadId: `t${i}` },
          })),
        },
      ],
    });
  await expect(fetchManagedGoogleGmailHistory(input)).rejects.toThrow("metadata read limit");
  expect(calls).toHaveLength(1);
  calls = [];
  response = async () => Response.json({ historyId: "120", history: [event(), event("102")] });
  expect((await fetchManagedGoogleGmailHistory(input)).events).toHaveLength(2);
  expect(calls.filter((url) => url.includes("/messages/"))).toHaveLength(1);
});

test("one request budget covers grant refresh, history and metadata without late success", async () => {
  const savedNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    tokenChanged = () => {
      now += 25_001;
    };
    await expect(fetchManagedGoogleGmailHistory(input)).rejects.toThrow("deadline exceeded");
    expect(calls).toHaveLength(0);
    tokenChanged = undefined;
    response = async () => {
      now += 15_000;
      return Response.json({ historyId: "120", history: [event()] });
    };
    metadataResponse = async (id) => {
      now += 10_001;
      return Response.json({ id, threadId: "thread-1", labelIds: ["INBOX", "UNREAD"] });
    };
    await expect(fetchManagedGoogleGmailHistory(input)).rejects.toThrow("deadline exceeded");
  } finally {
    Date.now = savedNow;
  }
});
