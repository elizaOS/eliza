/**
 * `GoogleWorkspaceService` — the sole runtime service and single entry point for
 * the plugin. Assembles the four sub-clients (Gmail, Calendar, Drive, Meet) over
 * a shared `GoogleApiClientFactory` and delegates every `IGoogleWorkspaceService`
 * method to the matching client. Retrieved via `runtime.getService("google")`.
 * Credential resolution defaults to `DefaultGoogleCredentialResolver` but can be
 * swapped (constructor option or `setCredentialResolver`) for tests.
 */
import type { ConnectorAccount, IAgentRuntime } from "@elizaos/core";
import { getConnectorAccountManager, logger, Service } from "@elizaos/core";
import {
  createMcpResourceEngine,
  type McpResourceEngine,
} from "@elizaos/plugin-mcp/resource-engine";
import { getGoogleOAuthProviderConfig, getGoogleOAuthProviderMetadata } from "./auth.js";
import { GoogleCalendarClient } from "./calendar.js";
import { GoogleApiClientFactory } from "./client-factory.js";
import { DefaultGoogleCredentialResolver } from "./credential-resolver.js";
import { GoogleDriveClient } from "./drive.js";
import { GoogleGmailClient } from "./gmail.js";
import { createGoogleMcpAccessTokenProvider } from "./mcp/access-token-provider.js";
import { listCalendarEventsViaMcp } from "./mcp/calendar-read-adapter.js";
import {
  type GoogleMcpAccountConnectionReport,
  GoogleMcpCapabilityHost,
} from "./mcp/capability-host.js";
import { GoogleMeetClient } from "./meet.js";
import { type GoogleCapability, scopesForGoogleCapabilities } from "./scopes.js";
import {
  GOOGLE_SERVICE_NAME,
  type GoogleAccountRef,
  type GoogleCalendarEvent,
  type GoogleCalendarEventDeleteInput,
  type GoogleCalendarEventInput,
  type GoogleCalendarEventListPage,
  type GoogleCalendarEventListPageInput,
  type GoogleCalendarEventPatchInput,
  type GoogleCalendarEventResponseInput,
  type GoogleCalendarFreeBusyInput,
  type GoogleCalendarFreeBusyResult,
  type GoogleCalendarListEntry,
  type GoogleCalendarListPage,
  type GoogleCalendarListPageInput,
  type GoogleCalendarStopChannelInput,
  type GoogleCalendarWatchInput,
  type GoogleCalendarWatchResponse,
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
  type GoogleMeetParticipantSession,
  type GoogleMeetParticipantSessionInput,
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
  mcpEngine?: McpResourceEngine;
}

export class GoogleWorkspaceService extends Service implements IGoogleWorkspaceService {
  static serviceType = GOOGLE_SERVICE_NAME;

  capabilityDescription =
    "Google Workspace service for Gmail, Calendar, Drive, and Meet using account-scoped OAuth";

  private readonly clientFactory: GoogleApiClientFactory;
  private credentialResolver: GoogleCredentialResolver;
  private readonly gmailClient: GoogleGmailClient;
  private readonly calendarClient: GoogleCalendarClient;
  private readonly driveClient: GoogleDriveClient;
  private readonly meetClient: GoogleMeetClient;
  private readonly mcpHost?: GoogleMcpCapabilityHost;

  constructor(runtime?: IAgentRuntime, options: GoogleWorkspaceServiceOptions = {}) {
    super(runtime);
    this.credentialResolver =
      options.credentialResolver ?? new DefaultGoogleCredentialResolver({ runtime });
    this.clientFactory = new GoogleApiClientFactory(this.credentialResolver);
    this.gmailClient = new GoogleGmailClient(this.clientFactory);
    this.calendarClient = new GoogleCalendarClient(this.clientFactory);
    this.driveClient = new GoogleDriveClient(this.clientFactory);
    this.meetClient = new GoogleMeetClient(this.clientFactory);
    if (runtime) {
      this.mcpHost = new GoogleMcpCapabilityHost(runtime, {
        engine: options.mcpEngine ?? createMcpResourceEngine(),
        accessTokenProviderFor: (account, product) =>
          createGoogleMcpAccessTokenProvider({
            accountId: account.id,
            product,
            resolveAuthClient: async (request) =>
              this.credentialResolver.getAuthClient({
                provider: GOOGLE_SERVICE_NAME,
                accountId: request.accountId,
                capabilities: [request.capability],
                scopes: scopesForGoogleCapabilities([request.capability]),
                reason: request.reason,
              }),
          }),
        authorizeAccount: async (accountId, requiredCapability) => {
          const evaluation = await getConnectorAccountManager(runtime).evaluatePolicy(
            {
              provider: GOOGLE_SERVICE_NAME,
              statuses: ["connected"],
              roles: ["OWNER", "AGENT", "TEAM"],
              accessGates: ["open", "owner_binding"],
              requiredCapabilities: [requiredCapability],
            },
            { accountId }
          );
          return evaluation.allowed;
        },
      });
    }
  }

  static async start(runtime: IAgentRuntime): Promise<GoogleWorkspaceService> {
    const service = new GoogleWorkspaceService(runtime);
    logger.info("Starting Google Workspace plugin");
    await service.restoreMcpAccounts();
    return service;
  }

  setCredentialResolver(credentialResolver: GoogleCredentialResolver): void {
    this.credentialResolver = credentialResolver;
    this.clientFactory.setCredentialResolver(credentialResolver);
  }

  async stop(): Promise<void> {
    await this.mcpHost?.stop();
    logger.info("Stopping Google Workspace plugin");
  }

  async connectMcpAccount(
    account: ConnectorAccount
  ): Promise<GoogleMcpAccountConnectionReport | null> {
    if (account.status !== "connected") {
      await this.mcpHost?.disconnectAccount(account.id);
      return null;
    }
    if (!this.mcpHost || (account.executionTarget ?? "agent_host") !== "agent_host") {
      await this.mcpHost?.disconnectAccount(account.id);
      return null;
    }
    return this.mcpHost.connectAccount(account);
  }

  async disconnectMcpAccount(accountId: string): Promise<void> {
    await this.mcpHost?.disconnectAccount(accountId);
  }

  private async restoreMcpAccounts(): Promise<void> {
    if (!this.runtime || !this.mcpHost) return;
    const accounts = await getConnectorAccountManager(this.runtime).listAccounts(
      GOOGLE_SERVICE_NAME
    );
    for (const account of accounts) {
      if (account.status !== "connected" || !account.selectedProducts?.length) continue;
      await this.connectMcpAccount(account);
    }
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

  listCalendarPage(params: GoogleCalendarListPageInput): Promise<GoogleCalendarListPage> {
    return this.calendarClient.listCalendarPage(params);
  }

  listEvents(
    params: GoogleAccountRef & {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      limit?: number;
      timeZone?: string;
    }
  ): Promise<GoogleCalendarEvent[]> {
    return this.listEventsWithFallback(params);
  }

  private async listEventsWithFallback(
    params: GoogleAccountRef & {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      limit?: number;
      timeZone?: string;
    }
  ): Promise<GoogleCalendarEvent[]> {
    if (this.mcpHost) {
      try {
        const events = await listCalendarEventsViaMcp(this.mcpHost, params);
        if (events) return events;
      } catch (error) {
        // error-policy:J4 A preview MCP read failure is surfaced to diagnostics
        // and visibly degrades to the stable direct Calendar read adapter.
        this.runtime?.reportError?.("google-mcp-calendar-read", error, {
          accountId: params.accountId,
          calendarId: params.calendarId ?? "primary",
        });
        logger.warn(
          {
            src: "plugin:google:mcp",
            accountId: params.accountId,
            err: error instanceof Error ? error.message : String(error),
          },
          "[GoogleWorkspaceService] Calendar MCP read failed; using direct API fallback"
        );
      }
    }
    return this.calendarClient.listEvents(params);
  }

  listEventPage(params: GoogleCalendarEventListPageInput): Promise<GoogleCalendarEventListPage> {
    return this.calendarClient.listEventPage(params);
  }

  watchEvents(params: GoogleCalendarWatchInput): Promise<GoogleCalendarWatchResponse> {
    return this.calendarClient.watchEvents(params);
  }

  stopCalendarChannel(params: GoogleCalendarStopChannelInput): Promise<void> {
    return this.calendarClient.stopCalendarChannel(params);
  }

  queryFreeBusy(params: GoogleCalendarFreeBusyInput): Promise<GoogleCalendarFreeBusyResult> {
    return this.calendarClient.queryFreeBusy(params);
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

  deleteEvent(params: GoogleCalendarEventDeleteInput): Promise<void> {
    return this.calendarClient.deleteEvent(params);
  }

  respondToEvent(params: GoogleCalendarEventResponseInput): Promise<GoogleCalendarEvent> {
    return this.calendarClient.respondToEvent(params);
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

  listMeetingParticipantSessions(
    params: GoogleMeetParticipantSessionInput & { limit?: number }
  ): Promise<GoogleMeetParticipantSession[]> {
    return this.meetClient.listMeetingParticipantSessions(params);
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
