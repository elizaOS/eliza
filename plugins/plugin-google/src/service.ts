import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service } from "@elizaos/core";
import { getGoogleOAuthProviderConfig, getGoogleOAuthProviderMetadata } from "./auth.js";
import { GoogleCalendarClient } from "./calendar.js";
import { GoogleApiClientFactory } from "./client-factory.js";
import { DefaultGoogleCredentialResolver } from "./credential-resolver.js";
import { GoogleDriveClient } from "./drive.js";
import { GoogleGmailClient } from "./gmail.js";
import { GoogleMeetClient } from "./meet.js";
import type { GoogleCapability } from "./scopes.js";
import {
  GOOGLE_SERVICE_NAME,
  type GoogleAccountRef,
  type GoogleCalendarEvent,
  type GoogleCalendarEventInput,
  type GoogleCalendarEventPatchInput,
  type GoogleCalendarListEntry,
  type GoogleCredentialResolver,
  type GoogleDocContent,
  type GoogleDriveCreateFileInput,
  type GoogleDriveFile,
  type GoogleDriveFileList,
  type GoogleGmailBulkOperation,
  type GoogleGmailFilterCreateResult,
  type GoogleGmailMessageDetail,
  type GoogleGmailMessageSummary,
  type GoogleGmailSendResult,
  type GoogleGmailSubscriptionMessageHeaders,
  type GoogleGmailUnrespondedThread,
  type GoogleMeetConferenceRecord,
  type GoogleMeetConferenceRecordInput,
  type GoogleMeetCreateMeetingInput,
  type GoogleMeetGenerateReportInput,
  type GoogleMeetGetMeetingInput,
  type GoogleMeetMeeting,
  type GoogleMeetParticipant,
  type GoogleMeetRecording,
  type GoogleMeetRecordingInput,
  type GoogleMeetReport,
  type GoogleMeetSpace,
  type GoogleMeetTranscript,
  type GoogleMeetTranscriptArtifact,
  type GoogleMeetTranscriptInput,
  type GoogleMessageSummary,
  type GoogleOAuthProviderConfig,
  type GoogleOAuthProviderMetadata,
  type GoogleParsedMailto,
  type GoogleSendEmailInput,
  type GoogleSheetContent,
  type GoogleSheetUpdateResult,
  type IGoogleWorkspaceService,
} from "./types.js";

export interface GoogleWorkspaceServiceOptions {
  credentialResolver?: GoogleCredentialResolver;
}

export class GoogleWorkspaceService extends Service implements IGoogleWorkspaceService {
  static serviceType = GOOGLE_SERVICE_NAME;

  capabilityDescription =
    "Google Workspace service for Gmail, Calendar, Drive, and Meet using account-scoped OAuth";

  private readonly clientFactory: GoogleApiClientFactory;
  private readonly gmailClient: GoogleGmailClient;
  private readonly calendarClient: GoogleCalendarClient;
  private readonly driveClient: GoogleDriveClient;
  private readonly meetClient: GoogleMeetClient;

  constructor(runtime?: IAgentRuntime, options: GoogleWorkspaceServiceOptions = {}) {
    super(runtime);
    this.clientFactory = new GoogleApiClientFactory(
      options.credentialResolver ?? new DefaultGoogleCredentialResolver({ runtime })
    );
    this.gmailClient = new GoogleGmailClient(this.clientFactory);
    this.calendarClient = new GoogleCalendarClient(this.clientFactory);
    this.driveClient = new GoogleDriveClient(this.clientFactory);
    this.meetClient = new GoogleMeetClient(this.clientFactory);
  }

  static async start(runtime: IAgentRuntime): Promise<GoogleWorkspaceService> {
    const service = new GoogleWorkspaceService(runtime);
    logger.info("Starting Google Workspace plugin");
    return service;
  }

  setCredentialResolver(credentialResolver: GoogleCredentialResolver): void {
    this.clientFactory.setCredentialResolver(credentialResolver);
  }

  async stop(): Promise<void> {
    logger.info("Stopping Google Workspace plugin");
  }

  getOAuthProviderMetadata(): GoogleOAuthProviderMetadata {
    return getGoogleOAuthProviderMetadata();
  }

  getOAuthProviderConfig(capabilities: readonly GoogleCapability[]): GoogleOAuthProviderConfig {
    return getGoogleOAuthProviderConfig(capabilities);
  }

  searchMessages(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleMessageSummary[]> {
    return this.gmailClient.searchMessages(params);
  }

  getMessage(
    params: GoogleAccountRef & { messageId: string; includeBody?: boolean }
  ): Promise<GoogleMessageSummary> {
    return this.gmailClient.getMessage(params);
  }

  sendEmail(params: GoogleSendEmailInput): Promise<{ id: string; threadId?: string }> {
    return this.gmailClient.sendEmail(params);
  }

  listGmailTriageMessages(
    params: GoogleAccountRef & { selfEmail?: string | null; maxResults?: number }
  ): Promise<GoogleGmailMessageSummary[]> {
    return this.gmailClient.listGmailTriageMessages(params);
  }

  searchGmailMessages(
    params: GoogleAccountRef & {
      query: string;
      selfEmail?: string | null;
      maxResults?: number;
      includeSpamTrash?: boolean;
    }
  ): Promise<GoogleGmailMessageSummary[]> {
    return this.gmailClient.searchGmailMessages(params);
  }

  getGmailMessage(
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageSummary | null> {
    return this.gmailClient.getGmailMessage(params);
  }

  getGmailMessageDetail(
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageDetail | null> {
    return this.gmailClient.getGmailMessageDetail(params);
  }

  listGmailUnrespondedThreads(
    params: GoogleAccountRef & {
      selfEmail?: string | null;
      olderThanDays?: number;
      maxResults?: number;
      now?: Date;
    }
  ): Promise<GoogleGmailUnrespondedThread[]> {
    return this.gmailClient.listGmailUnrespondedThreads(params);
  }

  modifyGmailMessages(
    params: GoogleAccountRef & {
      messageIds: readonly string[];
      operation: GoogleGmailBulkOperation;
      labelIds?: readonly string[];
    }
  ): Promise<void> {
    return this.gmailClient.modifyGmailMessages(params);
  }

  sendGmailReply(
    params: GoogleAccountRef & {
      to: string[];
      cc?: string[];
      subject: string;
      bodyText: string;
      inReplyTo?: string | null;
      references?: string | null;
    }
  ): Promise<GoogleGmailSendResult> {
    return this.gmailClient.sendGmailReply(params);
  }

  sendGmailMessage(
    params: GoogleAccountRef & {
      to: string[];
      cc?: string[];
      bcc?: string[];
      subject: string;
      bodyText: string;
    }
  ): Promise<GoogleGmailSendResult> {
    return this.gmailClient.sendGmailMessage(params);
  }

  getGmailSubscriptionHeaders(
    params: GoogleAccountRef & { query?: string; maxMessages?: number }
  ): Promise<GoogleGmailSubscriptionMessageHeaders[]> {
    return this.gmailClient.getGmailSubscriptionHeaders(params);
  }

  createGmailFilterForSender(
    params: GoogleAccountRef & { fromAddress: string; trash?: boolean }
  ): Promise<GoogleGmailFilterCreateResult> {
    return this.gmailClient.createGmailFilterForSender(params);
  }

  trashGmailThread(params: GoogleAccountRef & { threadId: string }): Promise<void> {
    return this.gmailClient.trashGmailThread(params);
  }

  modifyGmailMessageLabels(
    params: GoogleAccountRef & {
      messageId: string;
      addLabelIds?: string[];
      removeLabelIds?: string[];
    }
  ): Promise<void> {
    return this.gmailClient.modifyGmailMessageLabels(params);
  }

  sendMailtoUnsubscribeEmail(
    params: GoogleAccountRef & { mailto: GoogleParsedMailto }
  ): Promise<void> {
    return this.gmailClient.sendMailtoUnsubscribeEmail(params);
  }

  listCalendars(params: GoogleAccountRef): Promise<GoogleCalendarListEntry[]> {
    return this.calendarClient.listCalendars(params);
  }

  listEvents(
    params: GoogleAccountRef & {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      limit?: number;
    }
  ): Promise<GoogleCalendarEvent[]> {
    return this.calendarClient.listEvents(params);
  }

  getEvent(
    params: GoogleAccountRef & { calendarId?: string; eventId: string; timeZone?: string }
  ): Promise<GoogleCalendarEvent> {
    return this.calendarClient.getEvent(params);
  }

  createEvent(params: GoogleCalendarEventInput): Promise<GoogleCalendarEvent> {
    return this.calendarClient.createEvent(params);
  }

  updateEvent(params: GoogleCalendarEventPatchInput): Promise<GoogleCalendarEvent> {
    return this.calendarClient.updateEvent(params);
  }

  deleteEvent(params: GoogleAccountRef & { calendarId?: string; eventId: string }): Promise<void> {
    return this.calendarClient.deleteEvent(params);
  }

  searchFiles(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleDriveFile[]> {
    return this.driveClient.searchFiles(params);
  }

  getFile(params: GoogleAccountRef & { fileId: string }): Promise<GoogleDriveFile> {
    return this.driveClient.getFile(params);
  }

  listDriveFiles(
    params: GoogleAccountRef & { folderId?: string; maxResults?: number; pageToken?: string }
  ): Promise<GoogleDriveFileList> {
    return this.driveClient.listDriveFiles(params);
  }

  searchDriveFiles(
    params: GoogleAccountRef & { query: string; maxResults?: number; pageToken?: string }
  ): Promise<GoogleDriveFileList> {
    return this.driveClient.searchDriveFiles(params);
  }

  getDocContent(params: GoogleAccountRef & { documentId: string }): Promise<GoogleDocContent> {
    return this.driveClient.getDocContent(params);
  }

  getSheetContent(
    params: GoogleAccountRef & { spreadsheetId: string; range?: string }
  ): Promise<GoogleSheetContent> {
    return this.driveClient.getSheetContent(params);
  }

  createDriveFile(params: GoogleDriveCreateFileInput): Promise<GoogleDriveFile> {
    return this.driveClient.createDriveFile(params);
  }

  appendToDoc(params: GoogleAccountRef & { documentId: string; text: string }): Promise<void> {
    return this.driveClient.appendToDoc(params);
  }

  updateSheetCells(
    params: GoogleAccountRef & {
      spreadsheetId: string;
      range: string;
      values: ReadonlyArray<ReadonlyArray<string | number>>;
    }
  ): Promise<GoogleSheetUpdateResult> {
    return this.driveClient.updateSheetCells(params);
  }

  createMeeting(params: GoogleMeetCreateMeetingInput): Promise<GoogleMeetMeeting> {
    return this.meetClient.createMeeting(params);
  }

  getMeeting(params: GoogleMeetGetMeetingInput): Promise<GoogleMeetMeeting> {
    return this.meetClient.getMeeting(params);
  }

  getMeetingSpace(params: GoogleMeetGetMeetingInput): Promise<GoogleMeetSpace> {
    return this.meetClient.getMeetingSpace(params);
  }

  getConferenceRecord(
    params: GoogleMeetConferenceRecordInput
  ): Promise<GoogleMeetConferenceRecord> {
    return this.meetClient.getConferenceRecord(params);
  }

  listMeetingParticipants(
    params: GoogleMeetConferenceRecordInput & { limit?: number }
  ): Promise<GoogleMeetParticipant[]> {
    return this.meetClient.listMeetingParticipants(params);
  }

  listMeetingTranscripts(
    params: GoogleMeetConferenceRecordInput
  ): Promise<GoogleMeetTranscriptArtifact[]> {
    return this.meetClient.listMeetingTranscripts(params);
  }

  getMeetingTranscript(params: GoogleMeetTranscriptInput): Promise<GoogleMeetTranscript[]> {
    return this.meetClient.getMeetingTranscript(params);
  }

  listMeetingRecordings(params: GoogleMeetConferenceRecordInput): Promise<GoogleMeetRecording[]> {
    return this.meetClient.listMeetingRecordings(params);
  }

  getMeetingRecordingUrl(params: GoogleMeetRecordingInput): Promise<string | null> {
    return this.meetClient.getMeetingRecordingUrl(params);
  }

  endMeeting(params: GoogleAccountRef & { spaceName: string }): Promise<void> {
    return this.meetClient.endMeeting(params);
  }

  generateReport(params: GoogleMeetGenerateReportInput): Promise<GoogleMeetReport> {
    return this.meetClient.generateReport(params);
  }
}
