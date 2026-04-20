import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GoogleManagedClient,
  type ResolvedManagedGoogleCloudConfig,
} from "../src/lifeops/google-managed-client.js";

const CONFIG: ResolvedManagedGoogleCloudConfig = {
  configured: true,
  apiKey: "test-api-key",
  apiBaseUrl: "https://cloud.example.test/api/v1",
  siteUrl: "https://cloud.example.test",
};

/**
 * The cloud Managed Google routes live at /api/v1/milady/google/*. Historically
 * this client used an `eliza/google/*` prefix that 404s in production and was
 * swallowed by the Milady backend as "disconnected", making live connections
 * invisible in the LifeOps UI. These tests pin the URL prefix so that regression
 * cannot happen again.
 */
describe("GoogleManagedClient URL prefixes", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let capturedUrls: string[];
  let nextBody: unknown;

  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  beforeEach(() => {
    capturedUrls = [];
    nextBody = { ok: true };
    fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : (input as URL | Request).toString();
      capturedUrls.push(url);
      return jsonResponse(nextBody);
    });
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("getStatus targets /api/v1/milady/google/status with side query", async () => {
    nextBody = {
      provider: "google",
      side: "owner",
      mode: "cloud_managed",
      configured: true,
      connected: true,
      reason: "connected",
      identity: { id: "x" },
      grantedCapabilities: [],
      grantedScopes: [],
      expiresAt: null,
      hasRefreshToken: false,
      connectionId: "abc",
      linkedAt: "2026-04-17T00:00:00Z",
      lastUsedAt: null,
    };
    const client = new GoogleManagedClient(CONFIG);
    await client.getStatus("owner");
    expect(capturedUrls).toHaveLength(1);
    expect(capturedUrls[0]).toBe(
      "https://cloud.example.test/api/v1/milady/google/status?side=owner",
    );
  });

  it("listAccounts targets /api/v1/milady/google/accounts", async () => {
    nextBody = [];
    const client = new GoogleManagedClient(CONFIG);
    await client.listAccounts("owner");
    expect(capturedUrls[0]).toBe(
      "https://cloud.example.test/api/v1/milady/google/accounts?side=owner",
    );
  });

  it("disconnectConnector targets /api/v1/milady/google/disconnect", async () => {
    const client = new GoogleManagedClient(CONFIG);
    await client.disconnectConnector("cxn-1", "owner");
    expect(capturedUrls[0]).toBe(
      "https://cloud.example.test/api/v1/milady/google/disconnect",
    );
  });

  it("calendar, gmail read, and send endpoints all use /milady/google prefix", async () => {
    const client = new GoogleManagedClient(CONFIG);

    nextBody = { calendarId: "primary", events: [], syncedAt: "" };
    await client.getCalendarFeed({
      side: "owner",
      calendarId: "primary",
      timeMin: "2026-04-17T00:00:00Z",
      timeMax: "2026-04-18T00:00:00Z",
      timeZone: "UTC",
    });

    nextBody = { messages: [], syncedAt: "" };
    await client.getGmailTriage({ side: "owner", maxResults: 10 });
    await client.getGmailSearch({ side: "owner", query: "foo", maxResults: 10 });

    nextBody = {
      message: {
        externalId: "m1",
        threadId: "t1",
        subject: "s",
        from: "f",
        fromEmail: null,
        replyTo: null,
        to: [],
        cc: [],
        snippet: "",
        receivedAt: "",
        isUnread: false,
        isImportant: false,
        likelyReplyNeeded: false,
        triageScore: 0,
        triageReason: "",
        labels: [],
        htmlLink: null,
        metadata: {},
      },
      bodyText: "",
    };
    await client.readGmailMessage({ side: "owner", messageId: "m1" });

    nextBody = { ok: true };
    await client.sendGmailReply({
      side: "owner",
      to: ["x@y.z"],
      subject: "hi",
      bodyText: "body",
    });
    await client.sendGmailMessage({
      side: "owner",
      to: ["x@y.z"],
      subject: "hi",
      bodyText: "body",
    });

    for (const url of capturedUrls) {
      expect(url.startsWith("https://cloud.example.test/api/v1/milady/google/")).toBe(
        true,
      );
      expect(url).not.toContain("/eliza/google/");
    }

    expect(capturedUrls).toEqual([
      "https://cloud.example.test/api/v1/milady/google/calendar/feed?side=owner&calendarId=primary&timeMin=2026-04-17T00%3A00%3A00Z&timeMax=2026-04-18T00%3A00%3A00Z&timeZone=UTC",
      "https://cloud.example.test/api/v1/milady/google/gmail/triage?side=owner&maxResults=10",
      "https://cloud.example.test/api/v1/milady/google/gmail/search?side=owner&query=foo&maxResults=10",
      "https://cloud.example.test/api/v1/milady/google/gmail/read?side=owner&messageId=m1",
      "https://cloud.example.test/api/v1/milady/google/gmail/reply-send",
      "https://cloud.example.test/api/v1/milady/google/gmail/message-send",
    ]);
  });

  it("accepts a null-role cloud connection: the client relays side verbatim to the cloud, which is the behavior that lets a dashboard-created connection surface as owner", async () => {
    // The cloud's generic adapter treats rows lacking miladyGoogleSide
    // (legacy/dashboard-created connections) as connectionRole="owner".
    // This client must pass side=owner unchanged so that resolution works for
    // those rows; otherwise the LifeOps UI will still show "not connected".
    nextBody = {
      provider: "google",
      side: "owner",
      mode: "cloud_managed",
      configured: true,
      connected: true,
      reason: "connected",
      identity: { id: "legacy" },
      grantedCapabilities: [],
      grantedScopes: [],
      expiresAt: null,
      hasRefreshToken: true,
      connectionId: "legacy-id",
      linkedAt: "2026-04-17T00:00:00Z",
      lastUsedAt: null,
    };
    const client = new GoogleManagedClient(CONFIG);
    const status = await client.getStatus("owner");
    expect(status.connected).toBe(true);
    expect(status.connectionId).toBe("legacy-id");
    expect(capturedUrls[0]).toBe(
      "https://cloud.example.test/api/v1/milady/google/status?side=owner",
    );
  });
});
