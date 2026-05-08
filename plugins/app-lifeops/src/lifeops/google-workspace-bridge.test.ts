import type { IAgentRuntime } from "@elizaos/core";
import type {
  GoogleCalendarEvent,
  GoogleCalendarListEntry,
  GoogleDriveFile,
  GoogleMessageSummary,
  IGoogleWorkspaceService,
} from "@elizaos/plugin-google";
import { describe, expect, it, vi } from "vitest";
import type { LifeOpsConnectorGrant } from "../contracts/index.js";
import {
  createCalendarEventWithGoogleWorkspaceBridge,
  deleteCalendarEventWithGoogleWorkspaceBridge,
  getDriveFileWithGoogleWorkspaceBridge,
  listCalendarsWithGoogleWorkspaceBridge,
  listCalendarEventsWithGoogleWorkspaceBridge,
  readGmailMessageWithGoogleWorkspaceBridge,
  resolveGoogleWorkspaceAccountId,
  searchGmailMessagesWithGoogleWorkspaceBridge,
  searchDriveFilesWithGoogleWorkspaceBridge,
  sendGmailEmailWithGoogleWorkspaceBridge,
  updateCalendarEventWithGoogleWorkspaceBridge,
} from "./google-workspace-bridge.js";

function runtimeWithGoogleService(service: unknown): IAgentRuntime {
  return {
    getService: vi.fn((serviceType: string) =>
      serviceType === "google" ? service : null,
    ),
  } as unknown as IAgentRuntime;
}

function grant(
  overrides: Partial<LifeOpsConnectorGrant> = {},
): LifeOpsConnectorGrant {
  return {
    id: "legacy-grant-1",
    agentId: "agent-1",
    provider: "google",
    connectorAccountId: "google-account-1",
    side: "owner",
    identity: {},
    identityEmail: "owner@example.com",
    grantedScopes: [],
    capabilities: ["google.gmail.triage"],
    tokenRef: "token-ref-1",
    mode: "local",
    executionTarget: "local",
    sourceOfTruth: "local_storage",
    preferredByAgent: false,
    cloudConnectionId: null,
    metadata: {},
    lastRefreshAt: null,
    createdAt: "2026-05-08T00:00:00.000Z",
    updatedAt: "2026-05-08T00:00:00.000Z",
    ...overrides,
  };
}

describe("Google Workspace bridge", () => {
  it("uses connectorAccountId before legacy grant ids", () => {
    expect(
      resolveGoogleWorkspaceAccountId(
        grant({
          connectorAccountId: "connector-account",
          cloudConnectionId: "cloud-account",
        }),
      ),
    ).toBe("connector-account");

    expect(
      resolveGoogleWorkspaceAccountId(
        grant({
          connectorAccountId: null,
          cloudConnectionId: "cloud-account",
        }),
      ),
    ).toBe("cloud-account");

    expect(
      resolveGoogleWorkspaceAccountId(
        grant({
          connectorAccountId: null,
          cloudConnectionId: null,
          id: "legacy-grant",
        }),
      ),
    ).toBe("legacy-grant");
  });

  it("calls plugin-google Gmail search with accountId-first params", async () => {
    const googleMessage: GoogleMessageSummary = {
      id: "msg-1",
      threadId: "thread-1",
      subject: "Renewal receipt",
      from: { email: "billing@example.com", name: "Billing" },
      to: [{ email: "owner@example.com" }],
      snippet: "Your receipt is ready",
      receivedAt: "2026-05-08T12:00:00.000Z",
      labelIds: ["INBOX", "UNREAD"],
    };
    const searchMessages = vi.fn(
      async (_params: { accountId: string; query: string; limit?: number }) => [
        googleMessage,
      ],
    );
    const service: Partial<IGoogleWorkspaceService> = { searchMessages };

    const result = await searchGmailMessagesWithGoogleWorkspaceBridge({
      runtime: runtimeWithGoogleService(service),
      grant: grant(),
      query: "from:billing@example.com",
      maxResults: 5,
      includeSpamTrash: true,
    });

    expect(searchMessages).toHaveBeenCalledWith({
      accountId: "google-account-1",
      query: "from:billing@example.com in:anywhere",
      limit: 5,
    });
    expect(result).toMatchObject({
      status: "handled",
      accountId: "google-account-1",
      value: [
        {
          externalId: "msg-1",
          threadId: "thread-1",
          subject: "Renewal receipt",
          from: "Billing",
          fromEmail: "billing@example.com",
          to: ["owner@example.com"],
          isUnread: true,
          metadata: { googleWorkspaceBridge: true },
        },
      ],
    });
  });

  it("falls back when plugin-google is not registered", async () => {
    const result = await searchGmailMessagesWithGoogleWorkspaceBridge({
      runtime: runtimeWithGoogleService(null),
      grant: grant(),
      query: "subject:invoice",
      maxResults: 5,
    });

    expect(result).toMatchObject({
      status: "fallback",
      reason: "Google Workspace service searchMessages is not registered.",
    });
  });

  it("falls back when plugin-google cannot serve the account", async () => {
    const service: Partial<IGoogleWorkspaceService> = {
      searchMessages: vi.fn(async () => {
        throw new Error(
          "Google auth client for account google-account-1 is not available.",
        );
      }),
    };

    const result = await searchGmailMessagesWithGoogleWorkspaceBridge({
      runtime: runtimeWithGoogleService(service),
      grant: grant(),
      query: "subject:invoice",
      maxResults: 5,
    });

    expect(result.status).toBe("fallback");
    expect(result).toMatchObject({
      reason: "Google Workspace service searchMessages failed.",
    });
  });

  it("calls plugin-google Gmail getMessage with accountId-first params", async () => {
    const getMessage = vi.fn(
      async (_params: {
        accountId: string;
        messageId: string;
        includeBody?: boolean;
      }): Promise<GoogleMessageSummary> => ({
        id: "msg-2",
        threadId: "thread-2",
        subject: "Details",
        from: { email: "sam@example.com" },
        snippet: "Fallback snippet",
        bodyText: "Full body",
        receivedAt: "2026-05-08T13:00:00.000Z",
      }),
    );
    const service: Partial<IGoogleWorkspaceService> = { getMessage };

    const result = await readGmailMessageWithGoogleWorkspaceBridge({
      runtime: runtimeWithGoogleService(service),
      grant: grant(),
      messageId: "msg-2",
      includeBody: true,
    });

    expect(getMessage).toHaveBeenCalledWith({
      accountId: "google-account-1",
      messageId: "msg-2",
      includeBody: true,
    });
    expect(result).toMatchObject({
      status: "handled",
      value: {
        bodyText: "Full body",
        message: {
          externalId: "msg-2",
          subject: "Details",
        },
      },
    });
  });

  it("calls plugin-google Gmail sendEmail with accountId-first params", async () => {
    const sendEmail = vi.fn(async () => ({ id: "sent-1" }));
    const service: Partial<IGoogleWorkspaceService> = { sendEmail };

    const result = await sendGmailEmailWithGoogleWorkspaceBridge({
      runtime: runtimeWithGoogleService(service),
      grant: grant(),
      to: ["you@example.com"],
      cc: ["copy@example.com"],
      subject: "Update",
      bodyText: "Done",
      threadId: "thread-1",
    });

    expect(sendEmail).toHaveBeenCalledWith({
      accountId: "google-account-1",
      to: [{ email: "you@example.com" }],
      cc: [{ email: "copy@example.com" }],
      bcc: undefined,
      subject: "Update",
      text: "Done",
      html: undefined,
      threadId: "thread-1",
    });
    expect(result).toMatchObject({
      status: "handled",
      value: { messageId: "sent-1" },
    });
  });

  it("delegates Calendar listEvents and createEvent with accountId", async () => {
    const calendarEvent: GoogleCalendarEvent = {
      id: "event-1",
      calendarId: "primary",
      title: "Strategy",
      start: "2026-05-08T18:00:00.000Z",
      end: "2026-05-08T18:30:00.000Z",
      htmlLink: "https://calendar.google.com/event?event-1",
      attendees: [{ email: "sam@example.com", name: "Sam" }],
    };
    const listEvents = vi.fn(async () => [calendarEvent]);
    const createEvent = vi.fn(async () => ({
      ...calendarEvent,
      id: "event-2",
      title: "Created",
    }));
    const service: Partial<IGoogleWorkspaceService> = {
      listEvents,
      createEvent,
    };

    const listed = await listCalendarEventsWithGoogleWorkspaceBridge({
      runtime: runtimeWithGoogleService(service),
      grant: grant(),
      calendarId: "primary",
      timeMin: "2026-05-08T00:00:00.000Z",
      timeMax: "2026-05-09T00:00:00.000Z",
      timeZone: "America/Los_Angeles",
      maxResults: 10,
    });
    const created = await createCalendarEventWithGoogleWorkspaceBridge({
      runtime: runtimeWithGoogleService(service),
      grant: grant(),
      calendarId: "primary",
      title: "Created",
      startAt: "2026-05-08T18:00:00.000Z",
      endAt: "2026-05-08T18:30:00.000Z",
      timeZone: "America/Los_Angeles",
      attendees: [{ email: "sam@example.com", displayName: "Sam" }],
    });

    expect(listEvents).toHaveBeenCalledWith({
      accountId: "google-account-1",
      calendarId: "primary",
      timeMin: "2026-05-08T00:00:00.000Z",
      timeMax: "2026-05-09T00:00:00.000Z",
      limit: 10,
    });
    expect(createEvent).toHaveBeenCalledWith({
      accountId: "google-account-1",
      calendarId: "primary",
      title: "Created",
      description: undefined,
      location: undefined,
      start: "2026-05-08T18:00:00.000Z",
      end: "2026-05-08T18:30:00.000Z",
      timeZone: "America/Los_Angeles",
      attendees: [{ email: "sam@example.com", name: "Sam" }],
    });
    expect(listed).toMatchObject({
      status: "handled",
      value: [{ externalId: "event-1", title: "Strategy" }],
    });
    expect(created).toMatchObject({
      status: "handled",
      value: { externalId: "event-2", title: "Created" },
    });
  });

  it("delegates Calendar listCalendars, updateEvent, and deleteEvent with accountId", async () => {
    const calendar: GoogleCalendarListEntry = {
      calendarId: "primary",
      summary: "Owner",
      description: null,
      primary: true,
      accessRole: "owner",
      backgroundColor: null,
      foregroundColor: null,
      timeZone: "America/Los_Angeles",
      selected: true,
    };
    const updatedEvent: GoogleCalendarEvent = {
      id: "event-3",
      calendarId: "primary",
      title: "Updated",
      start: "2026-05-08T19:00:00.000Z",
      end: "2026-05-08T19:30:00.000Z",
    };
    const listCalendars = vi.fn(async () => [calendar]);
    const updateEvent = vi.fn(async () => updatedEvent);
    const deleteEvent = vi.fn(async () => undefined);
    const service: Partial<IGoogleWorkspaceService> = {
      listCalendars,
      updateEvent,
      deleteEvent,
    };
    const runtime = runtimeWithGoogleService(service);

    const listed = await listCalendarsWithGoogleWorkspaceBridge({
      runtime,
      grant: grant(),
    });
    const updated = await updateCalendarEventWithGoogleWorkspaceBridge({
      runtime,
      grant: grant(),
      calendarId: "primary",
      eventId: "event-3",
      title: "Updated",
      startAt: "2026-05-08T19:00:00.000Z",
      endAt: "2026-05-08T19:30:00.000Z",
      timeZone: "America/Los_Angeles",
    });
    const deleted = await deleteCalendarEventWithGoogleWorkspaceBridge({
      runtime,
      grant: grant(),
      calendarId: "primary",
      eventId: "event-3",
    });

    expect(listCalendars).toHaveBeenCalledWith({
      accountId: "google-account-1",
    });
    expect(updateEvent).toHaveBeenCalledWith({
      accountId: "google-account-1",
      calendarId: "primary",
      eventId: "event-3",
      title: "Updated",
      description: undefined,
      location: undefined,
      start: "2026-05-08T19:00:00.000Z",
      end: "2026-05-08T19:30:00.000Z",
      timeZone: "America/Los_Angeles",
      attendees: undefined,
    });
    expect(deleteEvent).toHaveBeenCalledWith({
      accountId: "google-account-1",
      calendarId: "primary",
      eventId: "event-3",
    });
    expect(listed).toMatchObject({
      status: "handled",
      value: [{ calendarId: "primary", summary: "Owner" }],
    });
    expect(updated).toMatchObject({
      status: "handled",
      value: { externalId: "event-3", title: "Updated" },
    });
    expect(deleted).toMatchObject({
      status: "handled",
      accountId: "google-account-1",
    });
  });

  it("delegates Drive searchFiles and getFile with accountId", async () => {
    const driveFile: GoogleDriveFile = {
      id: "file-1",
      name: "Roadmap",
      mimeType: "application/vnd.google-apps.document",
      webViewLink: "https://docs.google.com/document/d/file-1",
      parents: ["root"],
    };
    const searchFiles = vi.fn(async () => [driveFile]);
    const getFile = vi.fn(async () => driveFile);
    const service: Partial<IGoogleWorkspaceService> = { searchFiles, getFile };
    const runtime = runtimeWithGoogleService(service);

    const searched = await searchDriveFilesWithGoogleWorkspaceBridge({
      runtime,
      grant: grant(),
      query: "name contains 'Roadmap'",
      maxResults: 3,
    });
    const fetched = await getDriveFileWithGoogleWorkspaceBridge({
      runtime,
      grant: grant(),
      fileId: "file-1",
    });

    expect(searchFiles).toHaveBeenCalledWith({
      accountId: "google-account-1",
      query: "(name contains 'Roadmap') and trashed = false",
      limit: 3,
    });
    expect(getFile).toHaveBeenCalledWith({
      accountId: "google-account-1",
      fileId: "file-1",
    });
    expect(searched).toMatchObject({
      status: "handled",
      value: {
        files: [{ id: "file-1", name: "Roadmap" }],
        nextPageToken: null,
      },
    });
    expect(fetched).toMatchObject({
      status: "handled",
      value: { id: "file-1", name: "Roadmap", parents: ["root"] },
    });
  });

  it("falls back for delegated Calendar and Drive methods missing in plugin-google", async () => {
    const runtime = runtimeWithGoogleService({});

    await expect(
      deleteCalendarEventWithGoogleWorkspaceBridge({
        runtime,
        grant: grant(),
        eventId: "event-4",
      }),
    ).resolves.toMatchObject({
      status: "fallback",
      reason: "Google Workspace service deleteEvent is not registered.",
    });
    await expect(
      getDriveFileWithGoogleWorkspaceBridge({
        runtime,
        grant: grant(),
        fileId: "file-1",
      }),
    ).resolves.toMatchObject({
      status: "fallback",
      reason: "Google Workspace service getFile is not registered.",
    });
  });
});
