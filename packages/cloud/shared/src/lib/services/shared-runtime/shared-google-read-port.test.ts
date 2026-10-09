import { describe, expect, test } from "bun:test";
import { createSharedGoogleReadPort } from "./shared-google-read-port";

function fixture() {
  const calls: Array<{ name: string; args: unknown }> = [];
  const deps: NonNullable<Parameters<typeof createSharedGoogleReadPort>[1]> = {
    initiateManagedGoogleConnection: async (args: unknown) => {
      calls.push({ name: "connect", args });
      return {
        provider: "google" as const,
        side: "owner" as const,
        mode: "cloud_managed" as const,
        requestedCapabilities: [],
        redirectUri: "/cloud/connectors",
        authUrl: "https://accounts.google.com/",
      };
    },
    getManagedGoogleConnectorStatus: async (args: unknown) => {
      calls.push({ name: "status", args });
      return {
        provider: "google" as const,
        side: "owner" as const,
        mode: "cloud_managed" as const,
        configured: true,
        connected: true,
        reason: "connected" as const,
        identity: null,
        grantedCapabilities: ["google.gmail.triage", "google.calendar.read"],
        grantedScopes: [],
        expiresAt: null,
        hasRefreshToken: true,
        connectionId: "grant",
        linkedAt: null,
        lastUsedAt: null,
      };
    },
    fetchManagedGoogleGmailSearch: async (args: unknown) => {
      calls.push({ name: "search", args });
      return { messages: [], syncedAt: "2026-10-08T00:00:00Z" };
    },
    readManagedGoogleGmailMessage: async () => {
      throw new Error("NOT_EXPECTED");
    },
    fetchManagedGoogleCalendarFeed: async () => {
      throw new Error("NOT_EXPECTED");
    },
  };
  return { calls, deps };
}

describe("server-owned Shared Google read seam", () => {
  test("connect explicitly requests read scopes and cannot inherit broad provider defaults", async () => {
    const { calls, deps } = fixture();
    const port = createSharedGoogleReadPort(
      {
        organizationId: "org",
        userId: "owner",
        authorizePrivateRead: async () => {},
      },
      deps,
    );
    await port.connect();
    expect(calls).toEqual([
      {
        name: "connect",
        args: {
          organizationId: "org",
          userId: "owner",
          side: "owner",
          redirectUrl: "/cloud/connectors",
          personalContextPurpose: "personal_google_context_v1",
          capabilities: ["google.basic_identity", "google.gmail.triage", "google.calendar.read"],
        },
      },
    ]);
  });

  test("missing explicit grant and denied private-context consent perform no data reads", async () => {
    const { calls, deps } = fixture();
    const request = { kind: "gmail_search" as const, query: "meeting" };
    await expect(
      createSharedGoogleReadPort(
        {
          organizationId: "org",
          userId: "owner",
          authorizePrivateRead: async () => {},
        },
        deps,
      ).read(request),
    ).rejects.toThrow("SHARED_GOOGLE_EXPLICIT_GRANT_REQUIRED");
    await expect(
      createSharedGoogleReadPort(
        {
          organizationId: "org",
          userId: "owner",
          grantId: "grant",
          authorizePrivateRead: async () => {
            throw new Error("PRIVATE_CONTEXT_DENIED");
          },
        },
        deps,
      ).read(request),
    ).rejects.toThrow("PRIVATE_CONTEXT_DENIED");
    expect(calls).toHaveLength(0);
  });

  test("invalid request kinds and shapes cannot authorize or dispatch a service", async () => {
    const { calls, deps } = fixture();
    let authorizations = 0;
    const port = createSharedGoogleReadPort(
      {
        organizationId: "org",
        userId: "owner",
        grantId: "grant",
        authorizePrivateRead: async () => {
          authorizations += 1;
        },
      },
      deps,
    );
    for (const request of [
      {
        kind: "other",
        timeMin: "2026-10-08",
        timeMax: "2026-10-09",
        timeZone: "UTC",
      },
      { kind: "calendar", timeMin: "2026-10-08", timeMax: "2026-10-09" },
      { kind: "gmail_search", query: 42 },
      null,
    ]) {
      await expect(port.read(request)).rejects.toThrow("SHARED_GOOGLE_INVALID_INPUT");
    }
    expect(authorizations).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("calendar read preserves the requested month with a bounded Shared page", async () => {
    const { calls, deps } = fixture();
    deps.fetchManagedGoogleCalendarFeed = async (args) => {
      calls.push({ name: "calendar", args });
      return {
        calendarId: "primary",
        truncated: true,
        syncedAt: "2026-10-08",
        events: [
          {
            externalId: "e1",
            title: "t".repeat(256),
            location: "l".repeat(256),
            startAt: "2026-11-01",
            endAt: "2026-11-02",
            isAllDay: true,
            description: "excluded",
          } as Awaited<ReturnType<typeof deps.fetchManagedGoogleCalendarFeed>>["events"][number],
        ],
      };
    };
    const port = createSharedGoogleReadPort(
      {
        organizationId: "org",
        userId: "owner",
        grantId: "grant",
        authorizePrivateRead: async () => {},
      },
      deps,
    );
    expect(
      await port.read({
        kind: "calendar",
        timeMin: "2026-10-08T00:00:00Z",
        timeMax: "2026-11-09T00:00:00Z",
        timeZone: "UTC",
      }),
    ).toMatchObject({
      hasMore: true,
      truncated: true,
      events: [{ id: "e1", title: "t".repeat(256), location: "l".repeat(256) }],
    });
    expect(calls[1]).toMatchObject({
      name: "calendar",
      args: {
        grantId: "grant",
        calendarId: "primary",
        timeMax: "2026-11-09T00:00:00.000Z",
        limits: { maxEvents: 20, maxPages: 1 },
      },
    });
    const originalFeed = deps.fetchManagedGoogleCalendarFeed;
    for (const field of ["title", "location"] as const) {
      deps.fetchManagedGoogleCalendarFeed = async (args) => {
        const result = await originalFeed(args);
        result.events[0][field] = "x".repeat(257);
        return result;
      };
      await expect(
        port.read({
          kind: "calendar",
          timeMin: "2026-10-08",
          timeMax: "2026-11-09",
          timeZone: "UTC",
        }),
      ).rejects.toThrow(`event ${field} exceeds 256 characters`);
    }
    deps.fetchManagedGoogleCalendarFeed = async (args) => {
      const result = await originalFeed(args);
      return { ...result, events: Array.from({ length: 21 }, () => result.events[0]) };
    };
    await expect(
      port.read({
        kind: "calendar",
        timeMin: "2026-10-08",
        timeMax: "2026-11-09",
        timeZone: "UTC",
      }),
    ).rejects.toThrow("requested page limit");
  });

  test("read pins owner side and selected grant and excludes write methods", async () => {
    const { calls, deps } = fixture();
    const port = createSharedGoogleReadPort(
      {
        organizationId: "org",
        userId: "owner",
        grantId: "grant",
        authorizePrivateRead: async () => {},
      },
      deps,
    );
    expect(await port.read({ kind: "gmail_search", query: " meeting " })).toMatchObject({
      kind: "private_google_gmail_search",
      untrustedContent: true,
      messages: [],
    });
    expect(calls).toEqual([
      {
        name: "status",
        args: {
          organizationId: "org",
          userId: "owner",
          side: "owner",
          grantId: "grant",
          personalContextRead: true,
        },
      },
      {
        name: "search",
        args: {
          organizationId: "org",
          userId: "owner",
          side: "owner",
          grantId: "grant",
          personalContextRead: true,
          query: "meeting",
          maxResults: 5,
        },
      },
    ]);
    expect(Object.keys(port).sort()).toEqual(["connect", "read"]);
  });
  test("search preserves selected fields and declares unrequested remaining pages", async () => {
    const { deps } = fixture();
    const message = {
      externalId: "m1",
      subject: "s".repeat(256),
      from: "f".repeat(256),
      snippet: "x".repeat(512),
      receivedAt: "2026-10-08",
      extraPrivateMetadata: "must not enter model context",
    } as Awaited<ReturnType<typeof deps.fetchManagedGoogleGmailSearch>>["messages"][number];
    let pages = 0;
    deps.fetchManagedGoogleGmailSearch = async (args) => {
      pages++;
      expect(args.maxResults).toBe(5);
      expect(args.pageToken).toBeUndefined();
      return {
        messages: Array.from({ length: 5 }, () => message),
        syncedAt: "now",
        nextPageToken: "next",
      };
    };
    const port = createSharedGoogleReadPort(
      {
        organizationId: "org",
        userId: "owner",
        grantId: "grant",
        authorizePrivateRead: async () => {},
      },
      deps,
    );
    const result = await port.read({ kind: "gmail_search", query: "meeting" });
    expect(result).toMatchObject({ hasMore: true, truncated: true });
    if (result.kind !== "private_google_gmail_search") throw new Error("WRONG_KIND");
    expect(result.messages).toHaveLength(5);
    expect(result.messages[0]).toEqual({
      id: "m1",
      subject: "s".repeat(256),
      from: "f".repeat(256),
      snippet: "x".repeat(512),
      receivedAt: "2026-10-08",
    });
    expect(pages).toBe(1);
    for (const [field, limit] of [
      ["subject", 256],
      ["from", 256],
      ["snippet", 512],
    ] as const) {
      const original = message[field];
      message[field] = "x".repeat(limit + 1);
      await expect(port.read({ kind: "gmail_search", query: "meeting" })).rejects.toThrow(
        "No partial content was returned",
      );
      message[field] = original;
    }
    deps.fetchManagedGoogleGmailSearch = async () => ({
      messages: Array.from({ length: 6 }, () => message),
      syncedAt: "now",
    });
    await expect(port.read({ kind: "gmail_search", query: "meeting" })).rejects.toThrow(
      "requested page limit",
    );
  });

  test("message body is complete or explicitly rejected without dumping metadata", async () => {
    const { deps } = fixture();
    const result = {
      message: { externalId: "m1", subject: "s".repeat(256) } as Awaited<
        ReturnType<typeof deps.readManagedGoogleGmailMessage>
      >["message"],
      bodyText: `${"x".repeat(7985)}complete ending`,
      attachments: [],
    };
    deps.readManagedGoogleGmailMessage = async () => result;
    const port = createSharedGoogleReadPort(
      {
        organizationId: "org",
        userId: "owner",
        grantId: "grant",
        authorizePrivateRead: async () => {},
      },
      deps,
    );
    expect(await port.read({ kind: "gmail_message", messageId: "m1" })).toEqual({
      kind: "private_google_gmail_message",
      untrustedContent: true,
      id: "m1",
      subject: "s".repeat(256),
      bodyText: result.bodyText,
      truncated: false,
    });
    result.bodyText = "private-sentinel" + "x".repeat(8000);
    await expect(port.read({ kind: "gmail_message", messageId: "m1" })).rejects.toThrow(
      "message body exceeds 8000 characters",
    );
    result.bodyText = "complete body";
    result.message.subject = "x".repeat(257);
    await expect(port.read({ kind: "gmail_message", messageId: "m1" })).rejects.toThrow(
      "message subject exceeds 256 characters",
    );
  });
});
