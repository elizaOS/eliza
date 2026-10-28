/**
 * Drives the managed Gmail search through its authenticated fetch boundary.
 * Each page carries the mailbox historyId that Gmail reported before the page
 * was listed, so a client can see that the mailbox changed between pages.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { fetchManagedGoogleGmailSearch, readManagedGoogleGmailMessage } from "./gmail";
import { AgentGoogleConnectorError, managedGoogleConnectorDeps } from "./shared";

const savedFetch = globalThis.fetch;
const savedDeps = { ...managedGoogleConnectorDeps };
const savedEnv = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
};

const SEARCH = {
  organizationId: "org-1",
  userId: "user-1",
  side: "owner" as const,
  grantId: "conn-1",
  query: "in:inbox",
  maxResults: 2,
};

let mailboxHistoryId: unknown;
let requests: string[];
let connectionStatus = "active",
  connectionId = "conn-1",
  partStatus = 200,
  invalidPart = false;
let fullReadReached: (() => void) | null = null,
  finishFullRead: (() => void) | null = null;
let tokenReads = 0,
  authFailure: AgentGoogleConnectorError | null = null;

function message(id: string) {
  return {
    id,
    threadId: `thread-${id}`,
    labelIds: ["INBOX"],
    internalDate: "1767225600000",
    payload: {
      mimeType: "text/html",
      headers: [{ name: "Subject", value: `Subject ${id}` }],
      body: { data: Buffer.from("<p>Owned HTML body</p>").toString("base64url") },
    },
  };
}

function installGmail(pages: Record<string, { ids: string[]; next?: string }>) {
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname.endsWith("/labels"))
      return Response.json({
        labels: [
          { id: "Label_123", name: "Team / Projects", type: "user" },
          { id: "CATEGORY_SOCIAL", name: "CATEGORY_SOCIAL", type: "system" },
        ],
      });
    if (url.pathname.endsWith("/profile")) return Response.json({ historyId: mailboxHistoryId });
    if (url.pathname.endsWith("/messages")) {
      if (url.searchParams.has("labelIds"))
        requests.push(`label:${url.searchParams.get("labelIds")}`);
      requests.push(`spam:${url.searchParams.get("includeSpamTrash")}`);
      const page = pages[url.searchParams.get("pageToken") ?? ""];
      return Response.json({
        messages: page.ids.map((id) => ({ id, threadId: `thread-${id}` })),
        ...(page.next ? { nextPageToken: page.next } : {}),
      });
    }
    if (url.pathname === "/batch") {
      const ids = [
        ...String(init?.body).matchAll(/GET \/gmail\/v1\/users\/me\/messages\/([^?]+)\?/g),
      ].map((row) => decodeURIComponent(row[1]));
      const parts = ids.map(
        (id, index) =>
          `--batch_owned\r\nContent-Type: application/http\r\nContent-ID: <response-alpha-${index}>\r\n\r\nHTTP/1.1 ${partStatus} OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(invalidPart ? { id: null } : message(id))}\r\n`,
      );
      return new Response(parts.join("") + "--batch_owned--\r\n", {
        headers: { "Content-Type": "multipart/mixed; boundary=batch_owned" },
      });
    }
    if (url.searchParams.get("format") === "full" && fullReadReached) {
      const reached = fullReadReached;
      fullReadReached = null;
      await new Promise<void>((resolve) => {
        finishFullRead = resolve;
        reached();
      });
    }
    const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
    return Response.json(message(id));
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  requests = [];
  connectionStatus = "active";
  connectionId = "conn-1";
  partStatus = 200;
  invalidPart = false;
  fullReadReached = null;
  finishFullRead = null;
  tokenReads = 0;
  authFailure = null;
  process.env.GOOGLE_CLIENT_ID = "client-id";
  process.env.GOOGLE_CLIENT_SECRET = "client-secret";
  managedGoogleConnectorDeps.oauthService = {
    ...savedDeps.oauthService,
    listConnections: async () => [
      {
        id: connectionId,
        userId: "user-1",
        connectionRole: "owner",
        status: connectionStatus,
        platformUserId: "google-user",
        email: "owner@example.com",
        scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
        linkedAt: new Date(0),
      },
    ],
    getValidToken: async () => {
      if (++tokenReads === 3 && authFailure) throw authFailure;
      return { accessToken: "test-token" };
    },
    getValidTokenByPlatformWithConnectionId: async () => ({
      connectionId,
      token: { accessToken: "test-token" },
    }),
  } as unknown as typeof savedDeps.oauthService;
  managedGoogleConnectorDeps.dbRead = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  } as unknown as typeof savedDeps.dbRead;
});

afterEach(() => {
  globalThis.fetch = savedFetch;
  Object.assign(managedGoogleConnectorDeps, savedDeps);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  mock.restore();
});

describe("fetchManagedGoogleGmailSearch mailbox revision", () => {
  test("each page reports the mailbox historyId read before it was listed", async () => {
    installGmail({ "": { ids: ["m1", "m2"], next: "page-2" }, "page-2": { ids: ["m4"] } });
    mailboxHistoryId = "1000";
    const first = await fetchManagedGoogleGmailSearch(SEARCH);
    expect(first.mailboxHistoryId).toBe("1000");
    expect(first.nextPageToken).toBe("page-2");
    expect(requests.indexOf("/gmail/v1/users/me/profile")).toBeLessThan(
      requests.indexOf("/gmail/v1/users/me/messages"),
    );

    // m3 was removed after page 1, so Gmail's page 2 skips past it.
    mailboxHistoryId = "1001";
    const second = await fetchManagedGoogleGmailSearch({ ...SEARCH, pageToken: "page-2" });
    expect(second.messages.map((message) => message.externalId)).toEqual(["m4"]);
    expect(second.mailboxHistoryId).toBe("1001");
    expect(second.mailboxHistoryId).not.toBe(first.mailboxHistoryId);
  });
});

describe("Gmail reading failure and authority boundaries", () => {
  for (const status of [403, 429])
    test(`outer 200 with inner ${status} remains a typed provider 502`, async () => {
      installGmail({ "": { ids: ["m1"] } });
      mailboxHistoryId = "1000";
      partStatus = status;
      try {
        await fetchManagedGoogleGmailSearch(SEARCH);
        throw Error("Expected rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(AgentGoogleConnectorError);
        expect((error as AgentGoogleConnectorError).status).toBe(502);
      }
    });
  test("invalid batch payload remains typed 502", async () => {
    installGmail({ "": { ids: ["m1"] } });
    mailboxHistoryId = "1000";
    invalidPart = true;
    try {
      await fetchManagedGoogleGmailSearch(SEARCH);
      throw Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentGoogleConnectorError);
      expect((error as AgentGoogleConnectorError).status).toBe(502);
    }
  });
  test("typed auth failure at batch token lookup retains its original status and identity", async () => {
    installGmail({ "": { ids: ["m1"] } });
    mailboxHistoryId = "1000";
    authFailure = new AgentGoogleConnectorError(401, "Owned authentication failure");
    try {
      await fetchManagedGoogleGmailSearch(SEARCH);
      throw Error("Expected rejection");
    } catch (error) {
      expect(error).toBe(authFailure);
      expect((error as AgentGoogleConnectorError).status).toBe(401);
    }
  });
  for (const change of ["disconnect", "replacement"] as const)
    test(`full read refuses ${change} during await before returning HTML or text`, async () => {
      installGmail({ "": { ids: ["m1"] } });
      mailboxHistoryId = "1000";
      const reached = new Promise<void>((resolve) => {
        fullReadReached = resolve;
      });
      const read = readManagedGoogleGmailMessage({
        organizationId: SEARCH.organizationId,
        userId: SEARCH.userId,
        side: SEARCH.side,
        ...(change === "disconnect" ? { grantId: SEARCH.grantId } : {}),
        messageId: "m1",
      });
      const outcome = read.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await reached;
      if (change === "disconnect") connectionStatus = "revoked";
      else connectionId = "conn-replacement";
      finishFullRead!();
      const result = await outcome;
      expect("value" in result).toBe(false);
      if ("error" in result) {
        expect(result.error).toBeInstanceOf(AgentGoogleConnectorError);
        expect(result.error.status).toBe(409);
      }
    });
});

describe("Gmail folder catalog", () => {
  test("owner discovers labels and filters with the exact provider ID", async () => {
    installGmail({ "": { ids: ["m1"] } });
    const page = await fetchManagedGoogleGmailSearch({
      ...SEARCH,
      labelId: "Label_123",
      includeLabels: true,
    });
    expect(page.labels?.[0]).toEqual({ id: "Label_123", name: "Team / Projects", type: "user" });
    expect(requests).toContain("label:Label_123");
    expect(requests.filter((path) => path.endsWith("/labels"))).toHaveLength(1);
  });
  test("ordinary pages do not fetch the catalog", async () => {
    installGmail({ "": { ids: ["m1"] } });
    const page = await fetchManagedGoogleGmailSearch(SEARCH);
    expect(page.labels).toBeUndefined();
    expect(requests.some((path) => path.endsWith("/labels"))).toBe(false);
  });
  for (const query of ["in:spam", "in:trash", "in:anywhere"])
    test(`${query} includes spam and trash`, async () => {
      installGmail({ "": { ids: [] } });
      await fetchManagedGoogleGmailSearch({ ...SEARCH, query });
      expect(requests).toContain("spam:true");
    });
  test("categories keep ordinary mailbox exclusions", async () => {
    installGmail({ "": { ids: [] } });
    await fetchManagedGoogleGmailSearch({ ...SEARCH, query: "in:inbox category:primary" });
    expect(requests).toContain("spam:false");
  });
  test("malformed labels and agent catalog requests are rejected before provider reads", async () => {
    await expect(
      fetchManagedGoogleGmailSearch({ ...SEARCH, labelId: "Label_123&in:anywhere" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      fetchManagedGoogleGmailSearch({ ...SEARCH, side: "agent", includeLabels: true }),
    ).rejects.toMatchObject({ status: 403 });
    expect(requests).toHaveLength(0);
  });
});

describe("Gmail label payload authority", () => {
  test("catalog refuses a grant withdrawn during the provider response", async () => {
    installGmail({ "": { ids: [] } });
    const provider = globalThis.fetch;
    globalThis.fetch = mock(async (input, init) => {
      const response = await provider(input, init);
      if (String(input).includes("/labels?")) connectionStatus = "disconnected";
      return response;
    });
    await expect(
      fetchManagedGoogleGmailSearch({ ...SEARCH, includeLabels: true }),
    ).rejects.toMatchObject({ status: 409 });
  });
  test("malformed catalog never becomes usable labels", async () => {
    installGmail({ "": { ids: [] } });
    const provider = globalThis.fetch;
    globalThis.fetch = mock(async (input, init) =>
      String(input).includes("/labels?")
        ? Response.json({
            labels: [
              { id: "Label_123", name: "Projects", type: "user" },
              { id: "Label_123", name: "Duplicate", type: "user" },
            ],
          })
        : provider(input, init),
    );
    await expect(
      fetchManagedGoogleGmailSearch({ ...SEARCH, includeLabels: true }),
    ).rejects.toMatchObject({ status: 502 });
  });
  test("human read preserves original HTML", async () => {
    installGmail({ "": { ids: [] } });
    const pending = readManagedGoogleGmailMessage({ ...SEARCH, messageId: "m1" });
    await new Promise<void>((resolve) => {
      fullReadReached = resolve;
    });
    finishFullRead?.();
    const result = await pending;
    expect(result.bodyHtml).toBe("<p>Owned HTML body</p>");
  });
});
