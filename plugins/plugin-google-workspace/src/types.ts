/**
 * Shared type surface for the Google connector: the account reference every
 * call is scoped by (`GoogleAccountRef`), OAuth provider metadata/config shapes,
 * the DTOs returned by the official Google Workspace MCP resources, and the
 * `IGoogle*Service` interfaces that `GoogleWorkspaceService` implements.
 */
import type { Service } from "@elizaos/core";
import type { OAuth2Client } from "google-auth-library";
import type { GoogleCapability } from "./scopes.js";

export const GOOGLE_SERVICE_NAME = "google";

export type GoogleAccountId = string;

export interface GoogleAccountRef {
  accountId: GoogleAccountId;
}

export type GoogleAuthClient = OAuth2Client;

export interface GoogleAuthResolutionRequest extends GoogleAccountRef {
  provider: typeof GOOGLE_SERVICE_NAME;
  capabilities: readonly GoogleCapability[];
  scopes: readonly string[];
  reason: string;
}

export interface GoogleCredentialResolver {
  getAuthClient(request: GoogleAuthResolutionRequest): Promise<GoogleAuthClient>;
}

export interface GoogleOAuthProviderMetadata {
  provider: typeof GOOGLE_SERVICE_NAME;
  label: string;
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth";
  tokenEndpoint: "https://oauth2.googleapis.com/token";
  revokeEndpoint: "https://oauth2.googleapis.com/revoke";
  clientIdSetting: "GOOGLE_CLIENT_ID";
  clientSecretSetting: "GOOGLE_CLIENT_SECRET";
  redirectUriSetting: "GOOGLE_REDIRECT_URI";
  responseType: "code";
  accessType: "offline";
  prompt: "consent";
  supportsPkce: true;
  identityScopes: readonly string[];
  capabilities: readonly GoogleCapability[];
}

export interface GoogleOAuthProviderConfig {
  provider: typeof GOOGLE_SERVICE_NAME;
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth";
  tokenUrl: "https://oauth2.googleapis.com/token";
  capabilities: readonly GoogleCapability[];
  scopes: readonly string[];
  authorizationParams: {
    access_type: "offline";
    prompt: "consent";
    include_granted_scopes: "true";
  };
}

export interface GoogleEmailAddress {
  email: string;
  name?: string;
}

export type GoogleCalendarAttendeeResponseStatus =
  | "needsAction"
  | "declined"
  | "tentative"
  | "accepted";

export interface GoogleCalendarAttendeeInput extends GoogleEmailAddress {
  responseStatus?: GoogleCalendarAttendeeResponseStatus;
  optional?: boolean;
}

export interface GoogleCalendarAttendee extends GoogleEmailAddress {
  responseStatus: GoogleCalendarAttendeeResponseStatus | null;
  self: boolean;
  organizer: boolean;
  optional: boolean;
}

export type GoogleCalendarSendUpdates = "all" | "externalOnly" | "none";

export type GoogleCalendarTransparency = "opaque" | "transparent";

export type GoogleCalendarVisibility = "default" | "public" | "private" | "confidential";

export interface GoogleMessageSummary {
  id: string;
  threadId?: string;
  subject?: string;
  from?: GoogleEmailAddress;
  replyTo?: GoogleEmailAddress;
  to?: GoogleEmailAddress[];
  cc?: GoogleEmailAddress[];
  snippet?: string;
  receivedAt?: string;
  labelIds?: string[];
  bodyText?: string;
  bodyHtml?: string;
  headers?: Record<string, string>;
}

export interface GoogleCreateGmailDraftInput extends GoogleAccountRef {
  to: GoogleEmailAddress[];
  cc?: GoogleEmailAddress[];
  bcc?: GoogleEmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  /** Gmail message id used by the official MCP create_draft reply mode. */
  replyToMessageId?: string;
}

export type GoogleGmailBulkOperation =
  | "archive"
  | "trash"
  | "delete"
  | "report_spam"
  | "mark_read"
  | "mark_unread"
  | "apply_label"
  | "remove_label";

export interface GoogleGmailMessageSummary {
  externalId: string;
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  replyTo: string | null;
  to: string[];
  cc: string[];
  snippet: string;
  receivedAt: string;
  isUnread: boolean;
  isImportant: boolean;
  likelyReplyNeeded: boolean;
  triageScore: number;
  triageReason: string;
  labels: string[];
  htmlLink: string | null;
  metadata: Record<string, unknown>;
}

export interface GoogleGmailMessageDetail {
  message: GoogleGmailMessageSummary;
  bodyText: string;
}

/** Receipt for Gmail's MCP create_draft tool; it never proves delivery. */
export interface GoogleGmailDraftResult {
  draftId: string;
  threadId: string | null;
}

export interface GoogleParsedMailto {
  recipient: string;
  subject: string | null;
  body: string | null;
}

export interface GoogleCalendarEventInput extends GoogleAccountRef {
  calendarId?: string;
  title: string;
  start: string;
  end: string;
  attendees?: GoogleCalendarAttendeeInput[];
  location?: string;
  description?: string;
  createMeetLink?: boolean;
  timeZone?: string;
  /**
   * Controls attendee notification email. Omission is treated as `none` so an
   * agent cannot notify external people without making that side effect explicit.
   */
  sendUpdates?: GoogleCalendarSendUpdates;
  /** RFC 5545 recurrence lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]. */
  recurrence?: string[];
  /** Stable caller key required by LifeOps; MCP Calendar writes reject it until upstream supports idempotency. */
  idempotencyKey?: string;
}

export interface GoogleCalendarEventPatchInput extends GoogleAccountRef {
  calendarId?: string;
  eventId: string;
  title?: string;
  start?: string;
  end?: string;
  attendees?: GoogleCalendarAttendeeInput[];
  location?: string;
  description?: string;
  timeZone?: string;
  /** See {@link GoogleCalendarEventInput.sendUpdates}. */
  sendUpdates?: GoogleCalendarSendUpdates;
  /** Replacement RFC 5545 recurrence lines. Valid on series masters only. */
  recurrence?: string[];
  /** Provider ETag required by LifeOps; MCP Calendar writes remain unavailable without it. */
  expectedEtag?: string;
}

export interface GoogleCalendarEventDeleteInput extends GoogleAccountRef {
  calendarId?: string;
  eventId: string;
  /** See {@link GoogleCalendarEventInput.sendUpdates}. */
  sendUpdates?: GoogleCalendarSendUpdates;
  /** Provider ETag required by LifeOps; MCP Calendar writes remain unavailable without it. */
  expectedEtag?: string;
}

export interface GoogleCalendarEventResponseInput extends GoogleAccountRef {
  calendarId?: string;
  eventId: string;
  responseStatus: Extract<
    GoogleCalendarAttendeeResponseStatus,
    "accepted" | "declined" | "tentative"
  >;
  /** See {@link GoogleCalendarEventInput.sendUpdates}. */
  sendUpdates?: GoogleCalendarSendUpdates;
  /** Provider ETag required by LifeOps; MCP Calendar writes remain unavailable without it. */
  expectedEtag?: string;
}

export interface GoogleCalendarEvent {
  id: string;
  calendarId: string;
  title?: string;
  status?: string;
  start?: string;
  end?: string;
  isAllDay?: boolean;
  timeZone?: string | null;
  htmlLink?: string;
  meetLink?: string;
  attendees?: GoogleCalendarAttendee[];
  location?: string;
  description?: string;
  organizer?: GoogleEmailAddress & { self?: boolean };
  transparency?: GoogleCalendarTransparency;
  visibility?: GoogleCalendarVisibility;
  /** RFC 5545 recurrence lines when the event is a recurring series master. */
  recurrence?: string[] | null;
  /** Series master event id when this event is a flattened occurrence. */
  recurringEventId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface GoogleCalendarListEntry {
  calendarId: string;
  summary: string;
  description: string | null;
  primary: boolean;
  accessRole: string;
  backgroundColor: string | null;
  foregroundColor: string | null;
  timeZone: string | null;
  selected: boolean;
  /** Present on incremental-sync tombstones. */
  deleted?: boolean;
  hidden?: boolean;
}

export interface GoogleCalendarListPageInput extends GoogleAccountRef {
  pageToken?: string;
  syncToken?: string;
  maxResults?: number;
  showDeleted?: boolean;
  showHidden?: boolean;
  minAccessRole?: "freeBusyReader" | "reader" | "writer" | "owner";
}

export interface GoogleCalendarListPage {
  calendars: GoogleCalendarListEntry[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

export interface GoogleCalendarEventListPageInput extends GoogleAccountRef {
  calendarId?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  pageToken?: string;
  syncToken?: string;
  timeZone?: string;
  showDeleted?: boolean;
  /**
   * Google suppresses nextSyncToken on any events.list request that carries
   * orderBy, so sync drains must leave this unset; only display paths that
   * need provider-side ordering opt in.
   */
  orderBy?: "startTime" | "updated";
}

export interface GoogleCalendarEventListPage {
  events: GoogleCalendarEvent[];
  nextPageToken: string | null;
  nextSyncToken: string | null;
}

export interface GoogleCalendarBusyInterval {
  start: string;
  end: string;
}

export interface GoogleCalendarFreeBusyError {
  domain: string | null;
  reason: string | null;
}

export interface GoogleCalendarFreeBusyCalendar {
  busy: GoogleCalendarBusyInterval[];
  errors: GoogleCalendarFreeBusyError[];
}

export interface GoogleCalendarFreeBusyInput extends GoogleAccountRef {
  timeMin: string;
  timeMax: string;
  calendarIds: readonly string[];
  timeZone?: string;
  groupExpansionMax?: number;
  calendarExpansionMax?: number;
}

/**
 * Availability-only response. It intentionally has no event metadata, titles,
 * descriptions, attendee identities, or expanded group membership.
 */
export interface GoogleCalendarFreeBusyResult {
  timeMin: string;
  timeMax: string;
  calendars: Record<string, GoogleCalendarFreeBusyCalendar>;
}

export interface GoogleDriveFile {
  id: string;
  name: string;
  mimeType?: string;
  createdTime?: string;
  webViewLink?: string;
  modifiedTime?: string;
  size?: string;
  parents?: string[];
}

export interface GoogleDriveFileList {
  files: GoogleDriveFile[];
  nextPageToken: string | null;
}

export interface GoogleDocContent {
  title: string;
  plainText: string;
}

export interface GoogleSheetContent {
  title: string;
  rows: string[][];
}

export interface GoogleDriveCreateFileInput extends GoogleAccountRef {
  name: string;
  mimeType: string;
  content?: string | Uint8Array;
  parentFolderId?: string;
}

export interface GoogleSheetUpdateResult {
  updatedRange: string;
  updatedCells: number;
}

export interface IGoogleGmailService extends Service {
  searchMessages(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleMessageSummary[]>;
  getMessage(
    params: GoogleAccountRef & { messageId: string; includeBody?: boolean }
  ): Promise<GoogleMessageSummary>;
  createGmailDraft(params: GoogleCreateGmailDraftInput): Promise<GoogleGmailDraftResult>;
  listGmailTriageMessages(
    params: GoogleAccountRef & { selfEmail?: string | null; maxResults?: number }
  ): Promise<GoogleGmailMessageSummary[]>;
  searchGmailMessages(
    params: GoogleAccountRef & {
      query: string;
      selfEmail?: string | null;
      maxResults?: number;
      includeSpamTrash?: boolean;
    }
  ): Promise<GoogleGmailMessageSummary[]>;
  getGmailMessage(
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageSummary | null>;
  getGmailMessageDetail(
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageDetail | null>;
  modifyGmailMessages(
    params: GoogleAccountRef & {
      messageIds: readonly string[];
      operation: GoogleGmailBulkOperation;
      labelIds?: readonly string[];
    }
  ): Promise<void>;
  createGmailReplyDraft(
    params: GoogleAccountRef & {
      to: string[];
      cc?: string[];
      subject: string;
      bodyText: string;
      replyToMessageId: string;
    }
  ): Promise<GoogleGmailDraftResult>;
  createMailtoUnsubscribeDraft(
    params: GoogleAccountRef & { mailto: GoogleParsedMailto }
  ): Promise<GoogleGmailDraftResult>;
}

export interface IGoogleCalendarService extends Service {
  listCalendars(params: GoogleAccountRef): Promise<GoogleCalendarListEntry[]>;
  listCalendarPage(params: GoogleCalendarListPageInput): Promise<GoogleCalendarListPage>;
  listEvents(
    params: GoogleAccountRef & {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      /** Google page size; the convenience method still drains every page. */
      limit?: number;
      timeZone?: string;
    }
  ): Promise<GoogleCalendarEvent[]>;
  listEventPage(params: GoogleCalendarEventListPageInput): Promise<GoogleCalendarEventListPage>;
  queryFreeBusy(params: GoogleCalendarFreeBusyInput): Promise<GoogleCalendarFreeBusyResult>;
  getEvent(
    params: GoogleAccountRef & { calendarId?: string; eventId: string; timeZone?: string }
  ): Promise<GoogleCalendarEvent>;
  createEvent(params: GoogleCalendarEventInput): Promise<GoogleCalendarEvent>;
  updateEvent(params: GoogleCalendarEventPatchInput): Promise<GoogleCalendarEvent>;
  deleteEvent(params: GoogleCalendarEventDeleteInput): Promise<void>;
  respondToEvent(params: GoogleCalendarEventResponseInput): Promise<GoogleCalendarEvent>;
}

export interface IGoogleDriveService extends Service {
  searchFiles(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleDriveFile[]>;
  getFile(params: GoogleAccountRef & { fileId: string }): Promise<GoogleDriveFile>;
  listDriveFiles(
    params: GoogleAccountRef & { folderId?: string; maxResults?: number; pageToken?: string }
  ): Promise<GoogleDriveFileList>;
  searchDriveFiles(
    params: GoogleAccountRef & { query: string; maxResults?: number; pageToken?: string }
  ): Promise<GoogleDriveFileList>;
  getDocContent(params: GoogleAccountRef & { documentId: string }): Promise<GoogleDocContent>;
  getSheetContent(
    params: GoogleAccountRef & { spreadsheetId: string; range?: string }
  ): Promise<GoogleSheetContent>;
  createDriveFile(params: GoogleDriveCreateFileInput): Promise<GoogleDriveFile>;
  appendToDoc(params: GoogleAccountRef & { documentId: string; text: string }): Promise<void>;
  updateSheetCells(
    params: GoogleAccountRef & {
      spreadsheetId: string;
      range: string;
      values: ReadonlyArray<ReadonlyArray<string | number>>;
    }
  ): Promise<GoogleSheetUpdateResult>;
}

export interface IGoogleWorkspaceService
  extends IGoogleGmailService,
    IGoogleCalendarService,
    IGoogleDriveService {
  getOAuthProviderConfig(capabilities: readonly GoogleCapability[]): GoogleOAuthProviderConfig;
  getOAuthProviderMetadata(): GoogleOAuthProviderMetadata;
}
