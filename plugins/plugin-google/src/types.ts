/**
 * Shared type surface for the Google connector: the account reference every
 * call is scoped by (`GoogleAccountRef`), OAuth provider metadata/config shapes,
 * the DTOs returned by each sub-client (Gmail, Calendar, Drive, Meet), and the
 * `IGoogle*Service` interfaces that `GoogleWorkspaceService` implements. These
 * are the contract the service, clients, and consumers agree on.
 */
import type { Service } from "@elizaos/core";
// Import the auth client type through googleapis' own re-export so the type
// identity always matches the google-auth-library copy googleapis was built
// against (bun's isolated linker can install two copies, which makes a direct
// google-auth-library import nominally incompatible with googleapis Options).
import type { Auth } from "googleapis";
import type { GoogleCapability } from "./scopes.js";

export const GOOGLE_SERVICE_NAME = "google";

export type GoogleAccountId = string;

export interface GoogleAccountRef {
  accountId: GoogleAccountId;
}

export type GoogleAuthClient = Auth.OAuth2Client;

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

export interface GoogleGmailMessagePage {
  messageIds: string[];
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

export interface GoogleGmailExportAttachment {
  filename: string;
  mimeType: string;
  sha256: string;
  bytes: number;
  dataBase64?: string;
}

export interface GoogleGmailExportMessage extends GoogleMessageSummary {
  threadId: string;
  internalDateMs: number;
  historyId?: string;
  attachments: GoogleGmailExportAttachment[];
}

export interface GoogleGmailProfile {
  emailAddress: string;
  historyId?: string;
  messagesTotal?: number;
  threadsTotal?: number;
}

export interface GoogleSendEmailInput extends GoogleAccountRef {
  to: GoogleEmailAddress[];
  cc?: GoogleEmailAddress[];
  bcc?: GoogleEmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  threadId?: string;
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

export interface GoogleGmailUnrespondedThread {
  threadId: string;
  externalMessageId: string;
  subject: string;
  to: string[];
  cc: string[];
  lastOutboundAt: string;
  lastInboundAt: string | null;
  daysWaiting: number;
  snippet: string;
  labels: string[];
  htmlLink: string | null;
}

export interface GoogleGmailSendResult {
  messageId: string | null;
  threadId: string | null;
  labelIds: string[];
}

export interface GoogleGmailSubscriptionMessageHeaders {
  messageId: string;
  threadId: string;
  receivedAt: string;
  subject: string;
  fromDisplay: string;
  fromEmail: string | null;
  listId: string | null;
  listUnsubscribe: string | null;
  listUnsubscribePost: string | null;
  snippet: string;
  labels: string[];
}

export interface GoogleGmailFilterCreateResult {
  filterId: string | null;
  trashed: boolean;
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
  attendees?: GoogleEmailAddress[];
  location?: string;
  description?: string;
  createMeetLink?: boolean;
  timeZone?: string;
  /** RFC 5545 recurrence lines, e.g. ["RRULE:FREQ=WEEKLY;BYDAY=MO"]. */
  recurrence?: string[];
}

export interface GoogleCalendarEventPatchInput extends GoogleAccountRef {
  calendarId?: string;
  eventId: string;
  title?: string;
  start?: string;
  end?: string;
  attendees?: GoogleEmailAddress[];
  location?: string;
  description?: string;
  timeZone?: string;
  /** Replacement RFC 5545 recurrence lines. Valid on series masters only. */
  recurrence?: string[];
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
  attendees?: GoogleEmailAddress[];
  location?: string;
  description?: string;
  organizer?: GoogleEmailAddress & { self?: boolean };
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

export type GoogleMeetAccessType = "OPEN" | "TRUSTED" | "RESTRICTED";

export enum GoogleMeetStatus {
  WAITING = "waiting",
  ACTIVE = "active",
  ENDED = "ended",
  ERROR = "error",
}

export interface GoogleMeetSpace {
  id: string;
  spaceName: string;
  meetingCode?: string;
  meetingUri: string;
  title?: string;
  accessType?: GoogleMeetAccessType;
  activeConferenceRecord?: string;
}

export interface GoogleMeetMeeting extends GoogleMeetSpace {
  title?: string;
  startTime?: string;
  endTime?: string;
  participants: GoogleMeetParticipant[];
  transcripts: GoogleMeetTranscript[];
  status: GoogleMeetStatus;
}

export interface GoogleMeetConferenceRecord {
  id: string;
  name: string;
  spaceName?: string;
  startTime?: string;
  endTime?: string;
  expireTime?: string;
}

export interface GoogleMeetParticipant {
  id: string;
  name: string;
  displayName?: string;
  joinTime?: string;
  leaveTime?: string;
  isActive: boolean;
  userType?: "signed_in" | "anonymous" | "phone" | "unknown";
}

export interface GoogleMeetParticipantSession {
  id: string;
  name: string;
  participantId: string;
  participantName: string;
  startTime?: string;
  endTime?: string;
  isActive: boolean;
}

export interface GoogleMeetTranscript {
  id: string;
  speakerName?: string;
  speakerId?: string;
  text: string;
  timestamp?: string;
  startTime?: string;
  endTime?: string;
  languageCode?: string;
  confidence?: number;
}

export interface GoogleMeetTranscriptArtifact {
  id: string;
  name: string;
  documentId?: string;
  documentUri?: string;
  startTime?: string;
  endTime?: string;
  state?: string;
}

export interface GoogleMeetRecording {
  id: string;
  name: string;
  uri?: string;
  fileId?: string;
  startTime?: string;
  endTime?: string;
  state?: string;
}

export interface GoogleMeetActionItem {
  description: string;
  assignee?: string;
  dueDate?: string;
  priority: "low" | "medium" | "high";
}

export type GoogleMeetCanonicalStreamKind =
  | "google_transcript_entries"
  | "google_docs_transcript"
  | "google_recording"
  | "bot_free_system_audio"
  | "bot_free_microphone"
  | "bot_free_screen_video";

export interface GoogleMeetCanonicalStream {
  id: string;
  kind: GoogleMeetCanonicalStreamKind;
  artifactId?: string;
  uri?: string;
  fileId?: string;
  startedAt?: string;
  endedAt?: string;
  state?: string;
}

export interface GoogleMeetCanonicalParticipant {
  id: string;
  displayName: string;
  userType?: GoogleMeetParticipant["userType"];
  nameProvenance: "google_signed_in" | "google_anonymous" | "phone" | "unknown";
}

export interface GoogleMeetCanonicalParticipantSession {
  id: string;
  participantId: string;
  startedAt?: string;
  endedAt?: string;
  isActive: boolean;
}

export interface GoogleMeetCanonicalTranscriptSpan {
  id: string;
  streamId: string;
  source: "google_meet_transcript_entry" | "bot_free_capture";
  text: string;
  participantId?: string;
  speakerLabel?: string;
  startedAt?: string;
  endedAt?: string;
  languageCode?: string;
  provenance: {
    transcriptName?: string;
    entryName?: string;
    participantName?: string;
  };
}

export interface GoogleMeetCanonicalGeneratedNote {
  id: string;
  kind: "summary" | "key_point" | "action_item";
  text: string;
  sourceSpanIds: string[];
  assignee?: string;
  dueDate?: string;
  priority?: GoogleMeetActionItem["priority"];
}

export type GoogleMeetMissingArtifactReason =
  | "no_transcript"
  | "transcript_delayed"
  | "missing_recording"
  | "revoked_access"
  | "permission_denied"
  | "meeting_not_found"
  | "organizer_only_artifact"
  | "expired_media_url";

export interface GoogleMeetMissingArtifact {
  artifactType: "conference" | "transcript" | "recording" | "participant_sessions";
  reason: GoogleMeetMissingArtifactReason;
  message: string;
  sourceName?: string;
}

export interface GoogleMeetCanonicalWarning {
  code:
    | "docs_transcript_mismatch"
    | "speaker_reference_missing"
    | "transcript_entry_empty"
    | "organizer_only_artifact"
    | "expired_media_url";
  message: string;
  sourceName?: string;
}

export interface GoogleMeetBotFreeCaptureArtifact {
  id: string;
  systemAudioUri?: string;
  microphoneAudioUri?: string;
  screenVideoUri?: string;
  startedAt?: string;
  endedAt?: string;
  transcriptSpans?: GoogleMeetTranscript[];
}

export interface GoogleMeetCanonicalArtifact {
  schemaVersion: "elizaos.meeting_artifact.v1";
  source: "google_meet";
  meeting: {
    id: string;
    conferenceRecordName: string;
    spaceName?: string;
    startedAt?: string;
    endedAt?: string;
    expireTime?: string;
    durationMinutes: number;
  };
  streams: GoogleMeetCanonicalStream[];
  participants: GoogleMeetCanonicalParticipant[];
  participantSessions: GoogleMeetCanonicalParticipantSession[];
  transcriptSpans: GoogleMeetCanonicalTranscriptSpan[];
  generatedNotes: GoogleMeetCanonicalGeneratedNote[];
  recordings: GoogleMeetRecording[];
  warnings: GoogleMeetCanonicalWarning[];
  missingArtifacts: GoogleMeetMissingArtifact[];
  metrics: {
    transcriptWordCount: number;
    participantCount: number;
    participantSessionCount: number;
    transcriptSpanCount: number;
    recordingCount: number;
    missingArtifactCount: number;
    warningCount: number;
  };
}

export interface GoogleMeetCanonicalArtifactInput {
  meetingId: string;
  conferenceRecordName: string;
  conference: GoogleMeetConferenceRecord;
  participants: readonly GoogleMeetParticipant[];
  participantSessions?: readonly GoogleMeetParticipantSession[];
  transcriptArtifacts: readonly GoogleMeetTranscriptArtifact[];
  transcriptEntries: readonly GoogleMeetTranscript[];
  recordings: readonly GoogleMeetRecording[];
  summary: string;
  keyPoints: readonly string[];
  actionItems: readonly GoogleMeetActionItem[];
  googleDocsTranscriptText?: string;
  botFreeCapture?: GoogleMeetBotFreeCaptureArtifact;
}

export interface GoogleMeetReport {
  meetingId: string;
  conferenceRecordName: string;
  title?: string;
  date?: string;
  durationMinutes: number;
  participants: GoogleMeetParticipant[];
  summary: string;
  keyPoints: string[];
  actionItems: GoogleMeetActionItem[];
  fullTranscript: GoogleMeetTranscript[];
  recordings: GoogleMeetRecording[];
  participantSessions: GoogleMeetParticipantSession[];
  canonicalArtifact: GoogleMeetCanonicalArtifact;
}

export interface GoogleMeetCreateMeetingInput extends GoogleAccountRef {
  title?: string;
  accessType?: GoogleMeetAccessType;
}

export interface GoogleMeetGetMeetingInput extends GoogleAccountRef {
  meetingId: string;
}

export interface GoogleMeetConferenceRecordInput extends GoogleAccountRef {
  conferenceRecordName: string;
}

export interface GoogleMeetParticipantSessionInput extends GoogleAccountRef {
  participantName: string;
}

export interface GoogleMeetTranscriptInput extends GoogleAccountRef {
  transcriptName: string;
}

export interface GoogleMeetRecordingInput extends GoogleAccountRef {
  recordingName: string;
}

export interface GoogleMeetGenerateReportInput extends GoogleAccountRef {
  meetingId?: string;
  conferenceRecordName?: string;
  transcriptName?: string;
  includeSummary?: boolean;
  includeActionItems?: boolean;
  includeTranscript?: boolean;
  includeRecordings?: boolean;
  googleDocsTranscriptText?: string;
  botFreeCapture?: GoogleMeetBotFreeCaptureArtifact;
}

export interface IGoogleGmailService extends Service {
  getGmailProfile(params: GoogleAccountRef): Promise<GoogleGmailProfile>;
  listGmailMessagePage(
    params: GoogleAccountRef & {
      query: string;
      pageToken?: string;
      maxResults?: number;
      includeSpamTrash?: boolean;
    }
  ): Promise<GoogleGmailMessagePage>;
  getGmailExportMessage(
    params: GoogleAccountRef & {
      messageId: string;
      includeAttachmentData?: boolean;
    }
  ): Promise<GoogleGmailExportMessage>;
  searchMessages(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleMessageSummary[]>;
  getMessage(
    params: GoogleAccountRef & { messageId: string; includeBody?: boolean }
  ): Promise<GoogleMessageSummary>;
  sendEmail(params: GoogleSendEmailInput): Promise<{ id: string; threadId?: string }>;
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
  listGmailUnrespondedThreads(
    params: GoogleAccountRef & {
      selfEmail?: string | null;
      olderThanDays?: number;
      maxResults?: number;
      now?: Date;
    }
  ): Promise<GoogleGmailUnrespondedThread[]>;
  modifyGmailMessages(
    params: GoogleAccountRef & {
      messageIds: readonly string[];
      operation: GoogleGmailBulkOperation;
      labelIds?: readonly string[];
    }
  ): Promise<void>;
  sendGmailReply(
    params: GoogleAccountRef & {
      to: string[];
      cc?: string[];
      subject: string;
      bodyText: string;
      inReplyTo?: string | null;
      references?: string | null;
    }
  ): Promise<GoogleGmailSendResult>;
  sendGmailMessage(
    params: GoogleAccountRef & {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      bodyText: string;
    }
  ): Promise<GoogleGmailSendResult>;
  getGmailSubscriptionHeaders(
    params: GoogleAccountRef & { query?: string; maxMessages?: number }
  ): Promise<GoogleGmailSubscriptionMessageHeaders[]>;
  createGmailFilterForSender(
    params: GoogleAccountRef & { fromAddress: string; trash?: boolean }
  ): Promise<GoogleGmailFilterCreateResult>;
  trashGmailThread(params: GoogleAccountRef & { threadId: string }): Promise<void>;
  modifyGmailMessageLabels(
    params: GoogleAccountRef & {
      messageId: string;
      addLabelIds?: string[];
      removeLabelIds?: string[];
    }
  ): Promise<void>;
  sendMailtoUnsubscribeEmail(
    params: GoogleAccountRef & { mailto: GoogleParsedMailto }
  ): Promise<void>;
}

export interface IGoogleCalendarService extends Service {
  listCalendars(params: GoogleAccountRef): Promise<GoogleCalendarListEntry[]>;
  listEvents(
    params: GoogleAccountRef & {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      limit?: number;
    }
  ): Promise<GoogleCalendarEvent[]>;
  getEvent(
    params: GoogleAccountRef & { calendarId?: string; eventId: string; timeZone?: string }
  ): Promise<GoogleCalendarEvent>;
  createEvent(params: GoogleCalendarEventInput): Promise<GoogleCalendarEvent>;
  updateEvent(params: GoogleCalendarEventPatchInput): Promise<GoogleCalendarEvent>;
  deleteEvent(params: GoogleAccountRef & { calendarId?: string; eventId: string }): Promise<void>;
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

export interface IGoogleMeetService extends Service {
  createMeeting(params: GoogleMeetCreateMeetingInput): Promise<GoogleMeetMeeting>;
  getMeeting(params: GoogleMeetGetMeetingInput): Promise<GoogleMeetMeeting>;
  getMeetingSpace(params: GoogleMeetGetMeetingInput): Promise<GoogleMeetSpace>;
  getConferenceRecord(params: GoogleMeetConferenceRecordInput): Promise<GoogleMeetConferenceRecord>;
  listMeetingParticipants(
    params: GoogleMeetConferenceRecordInput & { limit?: number }
  ): Promise<GoogleMeetParticipant[]>;
  listMeetingParticipantSessions(
    params: GoogleMeetParticipantSessionInput & { limit?: number }
  ): Promise<GoogleMeetParticipantSession[]>;
  listMeetingTranscripts(
    params: GoogleMeetConferenceRecordInput
  ): Promise<GoogleMeetTranscriptArtifact[]>;
  getMeetingTranscript(params: GoogleMeetTranscriptInput): Promise<GoogleMeetTranscript[]>;
  listMeetingRecordings(params: GoogleMeetConferenceRecordInput): Promise<GoogleMeetRecording[]>;
  getMeetingRecordingUrl(params: GoogleMeetRecordingInput): Promise<string | null>;
  endMeeting(params: GoogleAccountRef & { spaceName: string }): Promise<void>;
  generateReport(params: GoogleMeetGenerateReportInput): Promise<GoogleMeetReport>;
}

export interface IGoogleWorkspaceService
  extends IGoogleGmailService,
    IGoogleCalendarService,
    IGoogleDriveService,
    IGoogleMeetService {
  getOAuthProviderConfig(capabilities: readonly GoogleCapability[]): GoogleOAuthProviderConfig;
  getOAuthProviderMetadata(): GoogleOAuthProviderMetadata;
}
