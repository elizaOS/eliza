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
      { kind: "other", timeMin: "2026-10-08", timeMax: "2026-10-09", timeZone: "UTC" },
      { kind: "calendar", timeMin: "2026-10-08", timeMax: "2026-10-09", timeZone: null },
      { kind: "gmail_search", query: 42 },
      null,
    ]) {
      await expect(port.read(request)).rejects.toThrow("SHARED_GOOGLE_INVALID_INPUT");
    }
    expect(authorizations).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("calendar read defaults omitted timezone to UTC and preserves the complete interval", async () => {
    const { calls, deps } = fixture();
    deps.fetchManagedGoogleCalendarFeed = async (args) => {
      calls.push({ name: "calendar", args });
      return { calendarId: "primary", events: [], syncedAt: "2026-10-08" };
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
      }),
    ).toMatchObject({ events: [] });
    expect(calls[1]).toMatchObject({
      name: "calendar",
      args: {
        grantId: "grant",
        calendarId: "primary",
        timeMin: "2026-10-08T00:00:00.000Z",
        timeMax: "2026-11-09T00:00:00.000Z",
        timeZone: "UTC",
      },
    });
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
          maxResults: 50,
        },
      },
    ]);
    expect(Object.keys(port).sort()).toEqual(["connect", "read"]);
  });
  test("search follows provider cursors and keeps all selected fields", async () => {
    const { deps } = fixture();
    const message = {
      externalId: "m1",
      subject: "s".repeat(300),
      from: "f".repeat(300),
      snippet: "x".repeat(900),
    } as Awaited<ReturnType<typeof deps.fetchManagedGoogleGmailSearch>>["messages"][number];
    let pages = 0;
    deps.fetchManagedGoogleGmailSearch = async (args) => {
      pages++;
      expect(args.pageToken).toBe(pages === 1 ? undefined : "next");
      return { messages: [message], syncedAt: "now", nextPageToken: pages === 1 ? "next" : null };
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
    expect(await port.read({ kind: "gmail_search", query: "meeting" })).toMatchObject({
      messages: [message, message],
    });
    expect(pages).toBe(2);
    deps.fetchManagedGoogleGmailSearch = async () => ({
      messages: [],
      syncedAt: "now",
      nextPageToken: "repeat",
    });
    await expect(port.read({ kind: "gmail_search", query: "meeting" })).rejects.toThrow(
      "repeated a page token",
    );
  });

  test("message body and metadata survive beyond the former truncation boundary", async () => {
    const { deps } = fixture();
    const result = {
      message: { externalId: "m1", subject: "s".repeat(300) } as Awaited<
        ReturnType<typeof deps.readManagedGoogleGmailMessage>
      >["message"],
      bodyText: "x".repeat(9000) + "complete ending",
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
    expect(await port.read({ kind: "gmail_message", messageId: "m1" })).toMatchObject(result);
  });
});
