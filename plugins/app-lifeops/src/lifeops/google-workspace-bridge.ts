import type { IAgentRuntime } from "@elizaos/core";
import type { LifeOpsConnectorGrant } from "../contracts/index.js";
import type {
  GoogleCalendarListEntry,
  SyncedGoogleCalendarEvent,
} from "./google-calendar.js";
import type { GoogleDriveFile } from "./google-drive.js";
import type {
  SyncedGoogleGmailMessageDetail,
  SyncedGoogleGmailMessageSummary,
} from "./google-gmail.js";

const GOOGLE_WORKSPACE_SERVICE_TYPE = "google";

interface GoogleWorkspaceEmailAddress {
  email: string;
  name?: string;
}

interface GoogleWorkspaceMessageSummary {
  id: string;
  threadId?: string;
  subject?: string;
  from?: GoogleWorkspaceEmailAddress;
  to?: GoogleWorkspaceEmailAddress[];
  snippet?: string;
  receivedAt?: string;
  labelIds?: string[];
  bodyText?: string;
  bodyHtml?: string;
}

interface GoogleWorkspaceCalendarEvent {
  id: string;
  calendarId: string;
  title?: string;
  start?: string;
  end?: string;
  htmlLink?: string;
  meetLink?: string;
  attendees?: GoogleWorkspaceEmailAddress[];
  location?: string;
  description?: string;
}

interface GoogleWorkspaceCalendarListEntry {
  calendarId: string;
  summary: string;
  description?: string | null;
  primary?: boolean;
  accessRole?: string;
  backgroundColor?: string | null;
  foregroundColor?: string | null;
  timeZone?: string | null;
  selected?: boolean;
}

interface GoogleWorkspaceDriveFile {
  id: string;
  name: string;
  mimeType?: string;
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  webViewLink?: string;
  parents?: string[];
}

type GoogleWorkspaceBridgeService = {
  searchMessages?: (params: {
    accountId: string;
    query: string;
    limit?: number;
  }) => Promise<GoogleWorkspaceMessageSummary[]>;
  getMessage?: (params: {
    accountId: string;
    messageId: string;
    includeBody?: boolean;
  }) => Promise<GoogleWorkspaceMessageSummary>;
  sendEmail?: (params: {
    accountId: string;
    to: GoogleWorkspaceEmailAddress[];
    cc?: GoogleWorkspaceEmailAddress[];
    bcc?: GoogleWorkspaceEmailAddress[];
    subject: string;
    text?: string;
    html?: string;
    threadId?: string;
  }) => Promise<{ id: string; threadId?: string }>;
  listCalendars?: (params: {
    accountId: string;
  }) => Promise<GoogleWorkspaceCalendarListEntry[]>;
  listEvents?: (params: {
    accountId: string;
    calendarId?: string;
    timeMin?: string;
    timeMax?: string;
    limit?: number;
  }) => Promise<GoogleWorkspaceCalendarEvent[]>;
  createEvent?: (params: {
    accountId: string;
    calendarId?: string;
    title: string;
    start: string;
    end: string;
    attendees?: GoogleWorkspaceEmailAddress[];
    location?: string;
    description?: string;
    timeZone?: string;
  }) => Promise<GoogleWorkspaceCalendarEvent>;
  updateEvent?: (params: {
    accountId: string;
    calendarId?: string;
    eventId: string;
    title?: string;
    start?: string;
    end?: string;
    attendees?: GoogleWorkspaceEmailAddress[];
    location?: string;
    description?: string;
    timeZone?: string;
  }) => Promise<GoogleWorkspaceCalendarEvent>;
  deleteEvent?: (params: {
    accountId: string;
    calendarId?: string;
    eventId: string;
  }) => Promise<void>;
  searchFiles?: (params: {
    accountId: string;
    query: string;
    limit?: number;
  }) => Promise<GoogleWorkspaceDriveFile[]>;
  getFile?: (params: {
    accountId: string;
    fileId: string;
  }) => Promise<GoogleWorkspaceDriveFile>;
};

export type GoogleWorkspaceBridgeResult<T> =
  | {
      status: "handled";
      accountId: string;
      value: T;
    }
  | {
      status: "fallback";
      reason: string;
      error?: unknown;
    };

type GoogleWorkspaceGrantRef = Pick<
  LifeOpsConnectorGrant,
  "id" | "connectorAccountId" | "cloudConnectionId"
>;

function trimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function hasSearchMessages(
  value: GoogleWorkspaceBridgeService | null,
): value is GoogleWorkspaceBridgeService &
  Required<Pick<GoogleWorkspaceBridgeService, "searchMessages">> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).searchMessages === "function"
  );
}

function hasGetMessage(
  value: GoogleWorkspaceBridgeService | null,
): value is GoogleWorkspaceBridgeService &
  Required<Pick<GoogleWorkspaceBridgeService, "getMessage">> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).getMessage === "function"
  );
}

function hasSendEmail(
  value: GoogleWorkspaceBridgeService | null,
): value is GoogleWorkspaceBridgeService &
  Required<Pick<GoogleWorkspaceBridgeService, "sendEmail">> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).sendEmail === "function"
  );
}

function hasListCalendars(
  value: GoogleWorkspaceBridgeService | null,
): value is GoogleWorkspaceBridgeService &
  Required<Pick<GoogleWorkspaceBridgeService, "listCalendars">> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).listCalendars === "function"
  );
}

function hasListEvents(
  value: GoogleWorkspaceBridgeService | null,
): value is GoogleWorkspaceBridgeService &
  Required<Pick<GoogleWorkspaceBridgeService, "listEvents">> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).listEvents === "function"
  );
}

function hasCreateEvent(
  value: GoogleWorkspaceBridgeService | null,
): value is GoogleWorkspaceBridgeService &
  Required<Pick<GoogleWorkspaceBridgeService, "createEvent">> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).createEvent === "function"
  );
}

function hasUpdateEvent(
  value: GoogleWorkspaceBridgeService | null,
): value is GoogleWorkspaceBridgeService &
  Required<Pick<GoogleWorkspaceBridgeService, "updateEvent">> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).updateEvent === "function"
  );
}

function hasDeleteEvent(
  value: GoogleWorkspaceBridgeService | null,
): value is GoogleWorkspaceBridgeService &
  Required<Pick<GoogleWorkspaceBridgeService, "deleteEvent">> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).deleteEvent === "function"
  );
}

function hasSearchFiles(
  value: GoogleWorkspaceBridgeService | null,
): value is GoogleWorkspaceBridgeService &
  Required<Pick<GoogleWorkspaceBridgeService, "searchFiles">> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).searchFiles === "function"
  );
}

function hasGetFile(
  value: GoogleWorkspaceBridgeService | null,
): value is GoogleWorkspaceBridgeService &
  Required<Pick<GoogleWorkspaceBridgeService, "getFile">> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).getFile === "function"
  );
}

export function resolveGoogleWorkspaceAccountId(
  grant: GoogleWorkspaceGrantRef,
): string {
  return (
    trimmedString(grant.connectorAccountId) ??
    trimmedString(grant.cloudConnectionId) ??
    grant.id
  );
}

export function resolveGoogleWorkspaceService(
  runtime: IAgentRuntime,
): GoogleWorkspaceBridgeService | null {
  const service = runtime.getService?.(GOOGLE_WORKSPACE_SERVICE_TYPE);
  return service && typeof service === "object"
    ? (service as GoogleWorkspaceBridgeService)
    : null;
}

function gmailQueryForBridge(args: {
  query: string;
  includeSpamTrash?: boolean;
}): string {
  const query = args.query.trim();
  if (
    args.includeSpamTrash === true &&
    !/(^|\s)in:anywhere(?:\s|$)/i.test(query)
  ) {
    return `${query} in:anywhere`;
  }
  return query;
}

function driveQueryForBridge(query: string): string {
  const trimmed = query.trim();
  return /\btrashed\s*=/.test(trimmed)
    ? trimmed
    : `(${trimmed}) and trashed = false`;
}

function addressDisplay(
  address: GoogleWorkspaceMessageSummary["from"] | undefined,
): string | null {
  if (!address) {
    return null;
  }
  return trimmedString(address.name) ?? trimmedString(address.email);
}

function addressEmail(
  address: GoogleWorkspaceMessageSummary["from"] | undefined,
): string | null {
  const email = trimmedString(address?.email);
  return email ? email.toLowerCase() : null;
}

function addressList(
  addresses: GoogleWorkspaceMessageSummary["to"] | undefined,
): string[] {
  return (addresses ?? [])
    .map(
      (address) => trimmedString(address.email) ?? trimmedString(address.name),
    )
    .filter((value): value is string => Boolean(value));
}

function isoOrNow(value: string | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed)
    ? new Date(parsed).toISOString()
    : new Date().toISOString();
}

export function mapGoogleWorkspaceMessageToSyncedGmailMessage(
  message: GoogleWorkspaceMessageSummary,
): SyncedGoogleGmailMessageSummary | null {
  const externalId = trimmedString(message.id);
  if (!externalId) {
    return null;
  }

  const labels = (message.labelIds ?? [])
    .map((label) => label.trim())
    .filter(Boolean);
  const fromEmail = addressEmail(message.from);
  const from = addressDisplay(message.from) ?? fromEmail ?? "Unknown sender";
  const receivedAt = isoOrNow(message.receivedAt);

  return {
    externalId,
    threadId: trimmedString(message.threadId) ?? externalId,
    subject: trimmedString(message.subject) ?? "(no subject)",
    from,
    fromEmail,
    replyTo: null,
    to: addressList(message.to),
    cc: [],
    snippet: trimmedString(message.snippet) ?? "",
    receivedAt,
    isUnread: labels.includes("UNREAD"),
    isImportant: labels.includes("IMPORTANT"),
    likelyReplyNeeded: false,
    triageScore: labels.includes("IMPORTANT") ? 0.5 : 0,
    triageReason:
      "Google Workspace bridge summary; legacy LifeOps triage was not applied.",
    labels,
    htmlLink: null,
    metadata: {
      googleWorkspaceBridge: true,
      bodyText: trimmedString(message.bodyText),
      bodyHtml: trimmedString(message.bodyHtml),
    },
  };
}

function mapGoogleWorkspaceMessageToSyncedGmailDetail(
  message: GoogleWorkspaceMessageSummary,
): SyncedGoogleGmailMessageDetail | null {
  const mapped = mapGoogleWorkspaceMessageToSyncedGmailMessage(message);
  if (!mapped) {
    return null;
  }
  return {
    message: mapped,
    bodyText:
      trimmedString(message.bodyText) ?? trimmedString(message.snippet) ?? "",
  };
}

function readCalendarInstant(
  value: string | undefined,
): { iso: string; isAllDay: boolean } | null {
  const trimmed = trimmedString(value);
  if (!trimmed) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return {
      iso: new Date(`${trimmed}T00:00:00.000Z`).toISOString(),
      isAllDay: true,
    };
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return {
    iso: new Date(parsed).toISOString(),
    isAllDay: false,
  };
}

export function mapGoogleWorkspaceCalendarEventToSyncedCalendarEvent(
  event: GoogleWorkspaceCalendarEvent,
  fallbackTimeZone?: string,
): SyncedGoogleCalendarEvent | null {
  const externalId = trimmedString(event.id);
  const calendarId = trimmedString(event.calendarId) ?? "primary";
  const start = readCalendarInstant(event.start);
  const end = readCalendarInstant(event.end);
  if (!externalId || !start || !end) {
    return null;
  }

  return {
    externalId,
    calendarId,
    title: trimmedString(event.title) ?? "Untitled event",
    description: trimmedString(event.description) ?? "",
    location: trimmedString(event.location) ?? "",
    status: "confirmed",
    startAt: start.iso,
    endAt: end.iso,
    isAllDay: start.isAllDay,
    timezone: trimmedString(fallbackTimeZone),
    htmlLink: trimmedString(event.htmlLink),
    conferenceLink: trimmedString(event.meetLink),
    organizer: null,
    attendees: (event.attendees ?? []).map((attendee) => ({
      email: trimmedString(attendee.email),
      displayName: trimmedString(attendee.name),
      responseStatus: null,
      self: false,
      organizer: false,
      optional: false,
    })),
    metadata: {
      googleWorkspaceBridge: true,
    },
  };
}

function mapGoogleWorkspaceCalendarListEntry(
  entry: GoogleWorkspaceCalendarListEntry,
): GoogleCalendarListEntry | null {
  const calendarId = trimmedString(entry.calendarId);
  if (!calendarId) {
    return null;
  }
  return {
    calendarId,
    summary: trimmedString(entry.summary) ?? calendarId,
    description: trimmedString(entry.description ?? undefined),
    primary: Boolean(entry.primary),
    accessRole: trimmedString(entry.accessRole) ?? "reader",
    backgroundColor: trimmedString(entry.backgroundColor ?? undefined),
    foregroundColor: trimmedString(entry.foregroundColor ?? undefined),
    timeZone: trimmedString(entry.timeZone ?? undefined),
    selected: entry.selected !== false,
  };
}

function mapGoogleWorkspaceDriveFile(
  file: GoogleWorkspaceDriveFile,
): GoogleDriveFile | null {
  const id = trimmedString(file.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: trimmedString(file.name) ?? id,
    mimeType: trimmedString(file.mimeType) ?? "",
    createdTime: trimmedString(file.createdTime),
    modifiedTime: trimmedString(file.modifiedTime),
    size: trimmedString(file.size),
    webViewLink: trimmedString(file.webViewLink),
    parents: (file.parents ?? [])
      .map((parent) => trimmedString(parent))
      .filter((parent): parent is string => parent !== null),
  };
}

/**
 * Migration boundary: LifeOps keeps its legacy Google REST implementation as
 * the fallback while selected paths start delegating to plugin-google's
 * account-scoped capability surface.
 */
export async function searchGmailMessagesWithGoogleWorkspaceBridge(args: {
  runtime: IAgentRuntime;
  grant: GoogleWorkspaceGrantRef;
  query: string;
  maxResults?: number;
  includeSpamTrash?: boolean;
}): Promise<GoogleWorkspaceBridgeResult<SyncedGoogleGmailMessageSummary[]>> {
  const service = resolveGoogleWorkspaceService(args.runtime);
  if (!hasSearchMessages(service)) {
    return {
      status: "fallback",
      reason: "Google Workspace service searchMessages is not registered.",
    };
  }

  const accountId = resolveGoogleWorkspaceAccountId(args.grant);
  try {
    const messages = await service.searchMessages({
      accountId,
      query: gmailQueryForBridge({
        query: args.query,
        includeSpamTrash: args.includeSpamTrash,
      }),
      limit: args.maxResults,
    });
    return {
      status: "handled",
      accountId,
      value: messages
        .map(mapGoogleWorkspaceMessageToSyncedGmailMessage)
        .filter(
          (message): message is SyncedGoogleGmailMessageSummary =>
            message !== null,
        ),
    };
  } catch (error) {
    return {
      status: "fallback",
      reason: "Google Workspace service searchMessages failed.",
      error,
    };
  }
}

export async function readGmailMessageWithGoogleWorkspaceBridge(args: {
  runtime: IAgentRuntime;
  grant: GoogleWorkspaceGrantRef;
  messageId: string;
  includeBody?: boolean;
}): Promise<GoogleWorkspaceBridgeResult<SyncedGoogleGmailMessageDetail>> {
  const service = resolveGoogleWorkspaceService(args.runtime);
  if (!hasGetMessage(service)) {
    return {
      status: "fallback",
      reason: "Google Workspace service getMessage is not registered.",
    };
  }

  const accountId = resolveGoogleWorkspaceAccountId(args.grant);
  try {
    const message = await service.getMessage({
      accountId,
      messageId: args.messageId,
      includeBody: args.includeBody,
    });
    const detail = mapGoogleWorkspaceMessageToSyncedGmailDetail(message);
    if (!detail) {
      return {
        status: "fallback",
        reason: "Google Workspace service getMessage returned invalid data.",
      };
    }
    return {
      status: "handled",
      accountId,
      value: detail,
    };
  } catch (error) {
    return {
      status: "fallback",
      reason: "Google Workspace service getMessage failed.",
      error,
    };
  }
}

export async function sendGmailEmailWithGoogleWorkspaceBridge(args: {
  runtime: IAgentRuntime;
  grant: GoogleWorkspaceGrantRef;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  html?: string;
  threadId?: string | null;
}): Promise<GoogleWorkspaceBridgeResult<{ messageId: string | null }>> {
  const service = resolveGoogleWorkspaceService(args.runtime);
  if (!hasSendEmail(service)) {
    return {
      status: "fallback",
      reason: "Google Workspace service sendEmail is not registered.",
    };
  }

  const accountId = resolveGoogleWorkspaceAccountId(args.grant);
  const toAddress = (email: string): GoogleWorkspaceEmailAddress => ({
    email,
  });
  try {
    const sent = await service.sendEmail({
      accountId,
      to: args.to.map(toAddress),
      cc: args.cc?.map(toAddress),
      bcc: args.bcc?.map(toAddress),
      subject: args.subject,
      text: args.bodyText,
      html: args.html,
      threadId: trimmedString(args.threadId ?? undefined) ?? undefined,
    });
    return {
      status: "handled",
      accountId,
      value: { messageId: trimmedString(sent.id) },
    };
  } catch (error) {
    return {
      status: "fallback",
      reason: "Google Workspace service sendEmail failed.",
      error,
    };
  }
}

export async function listCalendarsWithGoogleWorkspaceBridge(args: {
  runtime: IAgentRuntime;
  grant: GoogleWorkspaceGrantRef;
}): Promise<GoogleWorkspaceBridgeResult<GoogleCalendarListEntry[]>> {
  const service = resolveGoogleWorkspaceService(args.runtime);
  if (!hasListCalendars(service)) {
    return {
      status: "fallback",
      reason: "Google Workspace service listCalendars is not registered.",
    };
  }

  const accountId = resolveGoogleWorkspaceAccountId(args.grant);
  try {
    const calendars = await service.listCalendars({ accountId });
    return {
      status: "handled",
      accountId,
      value: calendars
        .map(mapGoogleWorkspaceCalendarListEntry)
        .filter(
          (calendar): calendar is GoogleCalendarListEntry => calendar !== null,
        ),
    };
  } catch (error) {
    return {
      status: "fallback",
      reason: "Google Workspace service listCalendars failed.",
      error,
    };
  }
}

export async function listCalendarEventsWithGoogleWorkspaceBridge(args: {
  runtime: IAgentRuntime;
  grant: GoogleWorkspaceGrantRef;
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  timeZone?: string;
  maxResults?: number;
}): Promise<GoogleWorkspaceBridgeResult<SyncedGoogleCalendarEvent[]>> {
  const service = resolveGoogleWorkspaceService(args.runtime);
  if (!hasListEvents(service)) {
    return {
      status: "fallback",
      reason: "Google Workspace service listEvents is not registered.",
    };
  }

  const accountId = resolveGoogleWorkspaceAccountId(args.grant);
  try {
    const events = await service.listEvents({
      accountId,
      calendarId: args.calendarId,
      timeMin: args.timeMin,
      timeMax: args.timeMax,
      limit: args.maxResults,
    });
    return {
      status: "handled",
      accountId,
      value: events
        .map((event) =>
          mapGoogleWorkspaceCalendarEventToSyncedCalendarEvent(
            event,
            args.timeZone,
          ),
        )
        .filter((event): event is SyncedGoogleCalendarEvent => event !== null),
    };
  } catch (error) {
    return {
      status: "fallback",
      reason: "Google Workspace service listEvents failed.",
      error,
    };
  }
}

export async function updateCalendarEventWithGoogleWorkspaceBridge(args: {
  runtime: IAgentRuntime;
  grant: GoogleWorkspaceGrantRef;
  calendarId?: string;
  eventId: string;
  title?: string;
  description?: string;
  location?: string;
  startAt?: string;
  endAt?: string;
  timeZone?: string;
  attendees?: Array<{
    email: string;
    displayName?: string;
  }>;
}): Promise<GoogleWorkspaceBridgeResult<SyncedGoogleCalendarEvent>> {
  const service = resolveGoogleWorkspaceService(args.runtime);
  if (!hasUpdateEvent(service)) {
    return {
      status: "fallback",
      reason: "Google Workspace service updateEvent is not registered.",
    };
  }

  const accountId = resolveGoogleWorkspaceAccountId(args.grant);
  try {
    const event = await service.updateEvent({
      accountId,
      calendarId: args.calendarId,
      eventId: args.eventId,
      title: args.title,
      description: args.description,
      location: args.location,
      start: args.startAt,
      end: args.endAt,
      timeZone: args.timeZone,
      attendees: args.attendees?.map((attendee) => ({
        email: attendee.email,
        name: attendee.displayName,
      })),
    });
    const mapped = mapGoogleWorkspaceCalendarEventToSyncedCalendarEvent(
      event,
      args.timeZone,
    );
    if (!mapped) {
      return {
        status: "fallback",
        reason: "Google Workspace service updateEvent returned invalid data.",
      };
    }
    return {
      status: "handled",
      accountId,
      value: mapped,
    };
  } catch (error) {
    return {
      status: "fallback",
      reason: "Google Workspace service updateEvent failed.",
      error,
    };
  }
}

export async function deleteCalendarEventWithGoogleWorkspaceBridge(args: {
  runtime: IAgentRuntime;
  grant: GoogleWorkspaceGrantRef;
  calendarId?: string;
  eventId: string;
}): Promise<GoogleWorkspaceBridgeResult<void>> {
  const service = resolveGoogleWorkspaceService(args.runtime);
  if (!hasDeleteEvent(service)) {
    return {
      status: "fallback",
      reason: "Google Workspace service deleteEvent is not registered.",
    };
  }

  const accountId = resolveGoogleWorkspaceAccountId(args.grant);
  try {
    await service.deleteEvent({
      accountId,
      calendarId: args.calendarId,
      eventId: args.eventId,
    });
    return {
      status: "handled",
      accountId,
      value: undefined,
    };
  } catch (error) {
    return {
      status: "fallback",
      reason: "Google Workspace service deleteEvent failed.",
      error,
    };
  }
}

export async function createCalendarEventWithGoogleWorkspaceBridge(args: {
  runtime: IAgentRuntime;
  grant: GoogleWorkspaceGrantRef;
  calendarId?: string;
  title: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  timeZone?: string;
  attendees?: Array<{
    email: string;
    displayName?: string;
  }>;
}): Promise<GoogleWorkspaceBridgeResult<SyncedGoogleCalendarEvent>> {
  const service = resolveGoogleWorkspaceService(args.runtime);
  if (!hasCreateEvent(service)) {
    return {
      status: "fallback",
      reason: "Google Workspace service createEvent is not registered.",
    };
  }

  const accountId = resolveGoogleWorkspaceAccountId(args.grant);
  try {
    const event = await service.createEvent({
      accountId,
      calendarId: args.calendarId,
      title: args.title,
      description: args.description,
      location: args.location,
      start: args.startAt,
      end: args.endAt,
      timeZone: args.timeZone,
      attendees: args.attendees?.map((attendee) => ({
        email: attendee.email,
        name: attendee.displayName,
      })),
    });
    const mapped = mapGoogleWorkspaceCalendarEventToSyncedCalendarEvent(
      event,
      args.timeZone,
    );
    if (!mapped) {
      return {
        status: "fallback",
        reason: "Google Workspace service createEvent returned invalid data.",
      };
    }
    return {
      status: "handled",
      accountId,
      value: mapped,
    };
  } catch (error) {
    return {
      status: "fallback",
      reason: "Google Workspace service createEvent failed.",
      error,
    };
  }
}

export async function searchDriveFilesWithGoogleWorkspaceBridge(args: {
  runtime: IAgentRuntime;
  grant: GoogleWorkspaceGrantRef;
  query: string;
  maxResults?: number;
}): Promise<
  GoogleWorkspaceBridgeResult<{
    files: GoogleDriveFile[];
    nextPageToken: string | null;
  }>
> {
  const service = resolveGoogleWorkspaceService(args.runtime);
  if (!hasSearchFiles(service)) {
    return {
      status: "fallback",
      reason: "Google Workspace service searchFiles is not registered.",
    };
  }

  const accountId = resolveGoogleWorkspaceAccountId(args.grant);
  try {
    const files = await service.searchFiles({
      accountId,
      query: driveQueryForBridge(args.query),
      limit: args.maxResults,
    });
    return {
      status: "handled",
      accountId,
      value: {
        files: files
          .map(mapGoogleWorkspaceDriveFile)
          .filter((file): file is GoogleDriveFile => file !== null),
        nextPageToken: null,
      },
    };
  } catch (error) {
    return {
      status: "fallback",
      reason: "Google Workspace service searchFiles failed.",
      error,
    };
  }
}

export async function getDriveFileWithGoogleWorkspaceBridge(args: {
  runtime: IAgentRuntime;
  grant: GoogleWorkspaceGrantRef;
  fileId: string;
}): Promise<GoogleWorkspaceBridgeResult<GoogleDriveFile>> {
  const service = resolveGoogleWorkspaceService(args.runtime);
  if (!hasGetFile(service)) {
    return {
      status: "fallback",
      reason: "Google Workspace service getFile is not registered.",
    };
  }

  const accountId = resolveGoogleWorkspaceAccountId(args.grant);
  try {
    const file = mapGoogleWorkspaceDriveFile(
      await service.getFile({
        accountId,
        fileId: args.fileId,
      }),
    );
    if (!file) {
      return {
        status: "fallback",
        reason: "Google Workspace service getFile returned invalid data.",
      };
    }
    return {
      status: "handled",
      accountId,
      value: file,
    };
  } catch (error) {
    return {
      status: "fallback",
      reason: "Google Workspace service getFile failed.",
      error,
    };
  }
}
