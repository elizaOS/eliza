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

export interface GoogleMessageSummary {
  id: string;
  threadId?: string;
  subject?: string;
  from?: GoogleEmailAddress;
  to?: GoogleEmailAddress[];
  snippet?: string;
  receivedAt?: string;
  labelIds?: string[];
  bodyText?: string;
  bodyHtml?: string;
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
}

export interface GoogleCalendarEvent {
  id: string;
  calendarId: string;
  title?: string;
  start?: string;
  end?: string;
  htmlLink?: string;
  meetLink?: string;
  attendees?: GoogleEmailAddress[];
  location?: string;
  description?: string;
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
}

export interface IGoogleGmailService extends Service {
  searchMessages(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleMessageSummary[]>;
  getMessage(
    params: GoogleAccountRef & { messageId: string; includeBody?: boolean }
  ): Promise<GoogleMessageSummary>;
  sendEmail(params: GoogleSendEmailInput): Promise<{ id: string; threadId?: string }>;
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
  createEvent(params: GoogleCalendarEventInput): Promise<GoogleCalendarEvent>;
  updateEvent(params: GoogleCalendarEventPatchInput): Promise<GoogleCalendarEvent>;
  deleteEvent(params: GoogleAccountRef & { calendarId?: string; eventId: string }): Promise<void>;
}

export interface IGoogleDriveService extends Service {
  searchFiles(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleDriveFile[]>;
  getFile(params: GoogleAccountRef & { fileId: string }): Promise<GoogleDriveFile>;
}

export interface IGoogleMeetService extends Service {
  createMeeting(params: GoogleMeetCreateMeetingInput): Promise<GoogleMeetMeeting>;
  getMeeting(params: GoogleMeetGetMeetingInput): Promise<GoogleMeetMeeting>;
  getMeetingSpace(params: GoogleMeetGetMeetingInput): Promise<GoogleMeetSpace>;
  getConferenceRecord(params: GoogleMeetConferenceRecordInput): Promise<GoogleMeetConferenceRecord>;
  listMeetingParticipants(
    params: GoogleMeetConferenceRecordInput & { limit?: number }
  ): Promise<GoogleMeetParticipant[]>;
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
