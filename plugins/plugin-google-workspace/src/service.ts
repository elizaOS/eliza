/**
 * Personal Google Workspace runtime facade backed exclusively by official
 * product-specific Google MCP resources. It owns account lifecycle, exact tool
 * invocation, stable DTO normalization, and no direct Google REST fallback.
 */
import type { ConnectorAccount, IAgentRuntime } from "@elizaos/core";
import { ElizaError, getConnectorAccountManager, logger, Service } from "@elizaos/core";
import {
  createMcpResourceEngine,
  type McpResourceEngine,
} from "@elizaos/plugin-mcp/resource-engine";
import { getGoogleOAuthProviderConfig, getGoogleOAuthProviderMetadata } from "./auth.js";
import { DefaultGoogleCredentialResolver } from "./credential-resolver.js";
import { createGoogleMcpAccessTokenProvider } from "./mcp/access-token-provider.js";
import {
  googleCalendarEventFromMcp,
  listCalendarEventsViaMcp,
} from "./mcp/calendar-read-adapter.js";
import {
  type GoogleMcpAccountConnectionReport,
  type GoogleMcpCapabilityCall,
  GoogleMcpCapabilityHost,
  type GoogleMcpProduct,
} from "./mcp/capability-host.js";
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
  type GoogleCreateGmailDraftInput,
  type GoogleCredentialResolver,
  type GoogleDocContent,
  type GoogleDriveCreateFileInput,
  type GoogleDriveFile,
  type GoogleDriveFileList,
  type GoogleGmailBulkOperation,
  type GoogleGmailDraftResult,
  type GoogleGmailMessageDetail,
  type GoogleGmailMessageSummary,
  type GoogleMessageSummary,
  type GoogleOAuthProviderConfig,
  type GoogleOAuthProviderMetadata,
  type GoogleParsedMailto,
  type GoogleSheetContent,
  type GoogleSheetUpdateResult,
  type IGoogleWorkspaceService,
} from "./types.js";

export interface GoogleWorkspaceServiceOptions {
  credentialResolver?: GoogleCredentialResolver;
  mcpEngine?: McpResourceEngine;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function toolPayload(execution: GoogleMcpCapabilityCall): Record<string, unknown> {
  if (execution.result.isError) {
    throw new ElizaError(`Google MCP ${execution.product} tool returned an error`, {
      code: "GOOGLE_MCP_TOOL_ERROR",
      context: { accountId: execution.accountId, product: execution.product },
    });
  }
  if (isRecord(execution.result.structuredContent)) {
    return execution.result.structuredContent;
  }
  const text = execution.result.content
    .filter(
      (content): content is Extract<(typeof execution.result.content)[number], { type: "text" }> =>
        content.type === "text"
    )
    .map((content) => content.text)
    .join("\n")
    .trim();
  if (text) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed)) return parsed;
    } catch (error) {
      throw new ElizaError("Google MCP returned non-JSON tool content", {
        code: "GOOGLE_MCP_RESPONSE_INVALID",
        context: { product: execution.product },
        cause: error,
      });
    }
  }
  throw new ElizaError("Google MCP returned no structured tool content", {
    code: "GOOGLE_MCP_RESPONSE_INVALID",
    context: { product: execution.product },
  });
}

function nestedRecord(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  return isRecord(payload[key]) ? payload[key] : payload;
}

function parseAddress(value: unknown): { email: string; name?: string } | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  const bracket = /^(.*?)\s*<([^>]+)>$/.exec(raw);
  return bracket
    ? { email: bracket[2].trim(), ...(bracket[1].trim() ? { name: bracket[1].trim() } : {}) }
    : { email: raw };
}

function gmailMessage(value: unknown): GoogleMessageSummary {
  if (!isRecord(value)) {
    throw new ElizaError("Gmail MCP returned a non-object message", {
      code: "GOOGLE_MCP_GMAIL_RESPONSE_INVALID",
    });
  }
  const id = optionalString(value.id);
  if (!id) {
    throw new ElizaError("Gmail MCP returned a message without an id", {
      code: "GOOGLE_MCP_GMAIL_RESPONSE_INVALID",
    });
  }
  return {
    id,
    threadId: optionalString(value.threadId),
    subject: optionalString(value.subject),
    from: parseAddress(value.sender),
    to: stringArray(value.toRecipients).map((email) => ({ email })),
    cc: stringArray(value.ccRecipients).map((email) => ({ email })),
    snippet: optionalString(value.snippet),
    receivedAt: optionalString(value.date),
    labelIds: stringArray(value.labelIds),
    bodyText: optionalString(value.plaintextBody),
    bodyHtml: optionalString(value.htmlBody),
  };
}

function gmailTriage(message: GoogleMessageSummary): GoogleGmailMessageSummary {
  const labels = message.labelIds ?? [];
  const fromEmail = message.from?.email ?? null;
  return {
    externalId: message.id,
    threadId: message.threadId ?? message.id,
    subject: message.subject ?? "(no subject)",
    from: message.from?.name ?? fromEmail ?? "Unknown sender",
    fromEmail,
    replyTo: message.replyTo?.email ?? null,
    to: (message.to ?? []).map((entry) => entry.email),
    cc: (message.cc ?? []).map((entry) => entry.email),
    snippet: message.snippet ?? message.bodyText?.slice(0, 240) ?? "",
    receivedAt: message.receivedAt ?? new Date(0).toISOString(),
    isUnread: labels.includes("UNREAD"),
    isImportant: labels.includes("IMPORTANT"),
    likelyReplyNeeded: labels.includes("INBOX") && !labels.includes("SENT"),
    triageScore: labels.includes("IMPORTANT") ? 90 : labels.includes("UNREAD") ? 70 : 40,
    triageReason: labels.includes("IMPORTANT")
      ? "Marked important in Gmail."
      : labels.includes("UNREAD")
        ? "Unread inbox message."
        : "Recent Gmail message.",
    labels,
    htmlLink: null,
    metadata: { source: "google-workspace-mcp" },
  };
}

function driveFile(value: unknown): GoogleDriveFile {
  if (!isRecord(value)) {
    throw new ElizaError("Drive MCP returned a non-object file", {
      code: "GOOGLE_MCP_DRIVE_RESPONSE_INVALID",
    });
  }
  const id = optionalString(value.id);
  if (!id) {
    throw new ElizaError("Drive MCP returned a file without an id", {
      code: "GOOGLE_MCP_DRIVE_RESPONSE_INVALID",
    });
  }
  return {
    id,
    name: optionalString(value.name) ?? optionalString(value.title) ?? "Untitled",
    mimeType: optionalString(value.mimeType),
    createdTime: optionalString(value.createdTime),
    modifiedTime: optionalString(value.modifiedTime),
    webViewLink:
      optionalString(value.viewUrl) ??
      optionalString(value.webViewLink) ??
      optionalString(value.url),
    size: optionalString(value.fileSize) ?? optionalString(value.size),
    parents: optionalString(value.parentId)
      ? [optionalString(value.parentId) as string]
      : stringArray(value.parents),
  };
}

export class GoogleWorkspaceService extends Service implements IGoogleWorkspaceService {
  static serviceType = GOOGLE_SERVICE_NAME;

  capabilityDescription =
    "Personal Google Workspace through official Gmail, Calendar, Drive, Docs, Sheets, Slides, Chat, and People MCP resources";

  private credentialResolver: GoogleCredentialResolver;
  private readonly mcpHost?: GoogleMcpCapabilityHost;

  constructor(runtime?: IAgentRuntime, options: GoogleWorkspaceServiceOptions = {}) {
    super(runtime);
    this.credentialResolver =
      options.credentialResolver ?? new DefaultGoogleCredentialResolver({ runtime });
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
        authorizeAccount: async (accountId, requiredCapability) =>
          (
            await getConnectorAccountManager(runtime).evaluatePolicy(
              {
                provider: GOOGLE_SERVICE_NAME,
                statuses: ["connected"],
                roles: ["OWNER", "AGENT", "TEAM"],
                accessGates: ["open", "owner_binding", "manual_approval"],
                requiredCapabilities: [requiredCapability],
              },
              { accountId }
            )
          ).allowed,
      });
    }
  }

  static async start(runtime: IAgentRuntime): Promise<GoogleWorkspaceService> {
    const service = new GoogleWorkspaceService(runtime);
    logger.info("[GoogleWorkspaceService] Starting MCP-only personal Google connector");
    await service.restoreMcpAccounts();
    return service;
  }

  setCredentialResolver(credentialResolver: GoogleCredentialResolver): void {
    this.credentialResolver = credentialResolver;
  }

  async stop(): Promise<void> {
    await this.mcpHost?.stop();
    logger.info("[GoogleWorkspaceService] Stopped MCP-only personal Google connector");
  }

  async connectMcpAccount(
    account: ConnectorAccount
  ): Promise<GoogleMcpAccountConnectionReport | null> {
    if (account.status !== "connected") {
      await this.mcpHost?.disconnectAccount(account.id);
      return null;
    }
    return this.mcpHost?.connectAccount(account) ?? null;
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
      if (account.status === "connected" && account.selectedProducts?.length) {
        await this.connectMcpAccount(account);
      }
    }
  }

  private async call(
    accountId: string,
    product: GoogleMcpProduct,
    toolName: string,
    arguments_: Readonly<Record<string, unknown>> = {}
  ): Promise<Record<string, unknown>> {
    if (!this.mcpHost) {
      throw new ElizaError("Google MCP execution requires a running agent runtime", {
        code: "GOOGLE_MCP_HOST_UNAVAILABLE",
      });
    }
    return toolPayload(
      await this.mcpHost.callTool({ accountId, product, toolName, arguments: arguments_ })
    );
  }

  getOAuthProviderMetadata(): GoogleOAuthProviderMetadata {
    return getGoogleOAuthProviderMetadata();
  }

  getOAuthProviderConfig(capabilities: readonly GoogleCapability[]): GoogleOAuthProviderConfig {
    return getGoogleOAuthProviderConfig(capabilities);
  }

  async searchMessages(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleMessageSummary[]> {
    const payload = await this.call(params.accountId, "gmail", "search_threads", {
      query: params.query,
      pageSize: Math.min(params.limit ?? 20, 50),
      view: "THREAD_VIEW_MINIMAL",
    });
    const threads = Array.isArray(payload.threads) ? payload.threads : [];
    return threads.flatMap((thread) => {
      if (!isRecord(thread) || !Array.isArray(thread.messages)) return [];
      return thread.messages.map((message) => {
        const normalized = gmailMessage(message);
        return { ...normalized, threadId: optionalString(thread.id) ?? normalized.threadId };
      });
    });
  }

  async getMessage(
    params: GoogleAccountRef & { messageId: string; includeBody?: boolean }
  ): Promise<GoogleMessageSummary> {
    const payload = await this.call(params.accountId, "gmail", "get_message", {
      messageId: params.messageId,
      messageFormat: params.includeBody === false ? "MINIMAL" : "FULL_CONTENT",
    });
    return gmailMessage(nestedRecord(payload, "message"));
  }

  async createGmailDraft(params: GoogleCreateGmailDraftInput): Promise<GoogleGmailDraftResult> {
    const payload = nestedRecord(
      await this.call(params.accountId, "gmail", "create_draft", {
        to: params.to.map((entry) => entry.email),
        ...(params.cc ? { cc: params.cc.map((entry) => entry.email) } : {}),
        ...(params.bcc ? { bcc: params.bcc.map((entry) => entry.email) } : {}),
        subject: params.subject,
        ...(params.text ? { body: params.text } : {}),
        ...(params.html ? { htmlBody: params.html } : {}),
        ...(params.replyToMessageId ? { replyToMessageId: params.replyToMessageId } : {}),
      }),
      "draft"
    );
    const draftId = optionalString(payload.id);
    if (!draftId) {
      throw new ElizaError("Gmail MCP create_draft returned no draft id", {
        code: "GOOGLE_MCP_GMAIL_RESPONSE_INVALID",
      });
    }
    return { draftId, threadId: optionalString(payload.threadId) ?? null };
  }

  async listGmailTriageMessages(
    params: GoogleAccountRef & { selfEmail?: string | null; maxResults?: number }
  ): Promise<GoogleGmailMessageSummary[]> {
    return (
      await this.searchMessages({
        accountId: params.accountId,
        query: "in:inbox -in:draft",
        limit: params.maxResults,
      })
    ).map(gmailTriage);
  }

  async searchGmailMessages(
    params: GoogleAccountRef & {
      query: string;
      selfEmail?: string | null;
      maxResults?: number;
      includeSpamTrash?: boolean;
    }
  ): Promise<GoogleGmailMessageSummary[]> {
    const query = params.includeSpamTrash ? `${params.query} in:anywhere` : params.query;
    return (
      await this.searchMessages({
        accountId: params.accountId,
        query,
        limit: params.maxResults,
      })
    ).map(gmailTriage);
  }

  async getGmailMessage(
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageSummary | null> {
    return gmailTriage(
      await this.getMessage({ accountId: params.accountId, messageId: params.messageId })
    );
  }

  async getGmailMessageDetail(
    params: GoogleAccountRef & { messageId: string; selfEmail?: string | null }
  ): Promise<GoogleGmailMessageDetail | null> {
    const message = await this.getMessage({
      accountId: params.accountId,
      messageId: params.messageId,
      includeBody: true,
    });
    return { message: gmailTriage(message), bodyText: message.bodyText ?? "" };
  }

  async modifyGmailMessages(
    params: GoogleAccountRef & {
      messageIds: readonly string[];
      operation: GoogleGmailBulkOperation;
      labelIds?: readonly string[];
    }
  ): Promise<void> {
    for (const messageId of params.messageIds) {
      if (params.operation === "delete") {
        throw new ElizaError("Gmail MCP does not support permanent message deletion", {
          code: "GOOGLE_MCP_OPERATION_UNSUPPORTED",
        });
      }
      if (params.operation === "trash" || params.operation === "report_spam") {
        throw new ElizaError("Official Gmail MCP does not support trash or spam operations", {
          code: "GOOGLE_MCP_OPERATION_UNSUPPORTED",
          context: { operation: params.operation, messageId },
        });
      }
      const labels =
        params.operation === "archive"
          ? ["INBOX"]
          : params.operation === "mark_read" || params.operation === "mark_unread"
            ? ["UNREAD"]
            : [...(params.labelIds ?? [])];
      const tool =
        params.operation === "archive" ||
        params.operation === "mark_read" ||
        params.operation === "remove_label"
          ? "unlabel_message"
          : "label_message";
      await this.call(params.accountId, "gmail", tool, { messageId, labelIds: labels });
    }
  }

  async createGmailReplyDraft(
    params: GoogleAccountRef & {
      to: string[];
      cc?: string[];
      subject: string;
      bodyText: string;
      replyToMessageId: string;
    }
  ): Promise<GoogleGmailDraftResult> {
    return this.createGmailDraft({
      accountId: params.accountId,
      to: params.to.map((email) => ({ email })),
      cc: params.cc?.map((email) => ({ email })),
      subject: params.subject,
      text: params.bodyText,
      replyToMessageId: params.replyToMessageId,
    });
  }

  createMailtoUnsubscribeDraft(
    params: GoogleAccountRef & { mailto: GoogleParsedMailto }
  ): Promise<GoogleGmailDraftResult> {
    return this.createGmailDraft({
      accountId: params.accountId,
      to: [{ email: params.mailto.recipient }],
      subject: params.mailto.subject ?? "Unsubscribe",
      text: params.mailto.body ?? "Please unsubscribe me from this mailing list.",
    });
  }

  async listCalendars(params: GoogleAccountRef): Promise<GoogleCalendarListEntry[]> {
    const page = await this.listCalendarPage(params);
    return page.calendars;
  }

  async listCalendarPage(params: GoogleCalendarListPageInput): Promise<GoogleCalendarListPage> {
    const payload = await this.call(params.accountId, "calendar", "list_calendars", {
      ...(params.maxResults ? { pageSize: Math.min(params.maxResults, 250) } : {}),
      ...(params.pageToken ? { pageToken: params.pageToken } : {}),
    });
    const calendars = (Array.isArray(payload.calendars) ? payload.calendars : []).flatMap(
      (value): GoogleCalendarListEntry[] => {
        if (!isRecord(value)) return [];
        const calendarId = optionalString(value.id);
        if (!calendarId) return [];
        return [
          {
            calendarId,
            summary: optionalString(value.summary) ?? calendarId,
            description: optionalString(value.description) ?? null,
            primary: value.primary === true,
            accessRole: optionalString(value.accessRole) ?? "reader",
            backgroundColor: optionalString(value.backgroundColor) ?? null,
            foregroundColor: optionalString(value.foregroundColor) ?? null,
            timeZone: optionalString(value.timeZone) ?? null,
            selected: value.selected !== false,
            deleted: value.deleted === true,
            hidden: value.hidden === true,
          },
        ];
      }
    );
    return {
      calendars,
      nextPageToken: optionalString(payload.nextPageToken) ?? null,
      nextSyncToken: null,
    };
  }

  async listEvents(
    params: GoogleAccountRef & {
      calendarId?: string;
      timeMin?: string;
      timeMax?: string;
      limit?: number;
      timeZone?: string;
    }
  ): Promise<GoogleCalendarEvent[]> {
    if (!this.mcpHost) throw new Error("Google MCP host unavailable");
    return (
      (await listCalendarEventsViaMcp(this.mcpHost, params)) ??
      (() => {
        throw new Error("Google Calendar MCP list_events is unavailable");
      })()
    );
  }

  async listEventPage(
    params: GoogleCalendarEventListPageInput
  ): Promise<GoogleCalendarEventListPage> {
    if (params.syncToken) {
      throw new ElizaError("Google MCP uses polling windows, not Calendar sync tokens", {
        code: "GOOGLE_MCP_SYNC_TOKEN_UNSUPPORTED",
      });
    }
    const calendarId = params.calendarId ?? "primary";
    const payload = await this.call(params.accountId, "calendar", "list_events", {
      calendarId,
      ...(params.timeMin ? { startTime: params.timeMin } : {}),
      ...(params.timeMax ? { endTime: params.timeMax } : {}),
      ...(params.maxResults ? { pageSize: Math.min(params.maxResults, 250) } : {}),
      ...(params.pageToken ? { pageToken: params.pageToken } : {}),
      ...(params.timeZone ? { timeZone: params.timeZone } : {}),
      orderBy: "startTime",
    });
    return {
      events: (Array.isArray(payload.events) ? payload.events : []).map((event) =>
        googleCalendarEventFromMcp(event, calendarId, params.timeZone)
      ),
      nextPageToken: optionalString(payload.nextPageToken) ?? null,
      nextSyncToken: null,
    };
  }

  async queryFreeBusy(params: GoogleCalendarFreeBusyInput): Promise<GoogleCalendarFreeBusyResult> {
    const calendars: GoogleCalendarFreeBusyResult["calendars"] = {};
    for (const calendarId of params.calendarIds) {
      const events = await this.listEvents({
        accountId: params.accountId,
        calendarId,
        timeMin: params.timeMin,
        timeMax: params.timeMax,
        timeZone: params.timeZone,
      });
      calendars[calendarId] = {
        busy: events.flatMap((event) =>
          event.start &&
          event.end &&
          event.status !== "cancelled" &&
          event.transparency !== "transparent"
            ? [{ start: event.start, end: event.end }]
            : []
        ),
        errors: [],
      };
    }
    return { timeMin: params.timeMin, timeMax: params.timeMax, calendars };
  }

  async getEvent(
    params: GoogleAccountRef & { calendarId?: string; eventId: string; timeZone?: string }
  ): Promise<GoogleCalendarEvent> {
    const calendarId = params.calendarId ?? "primary";
    const payload = await this.call(params.accountId, "calendar", "get_event", {
      calendarId,
      eventId: params.eventId,
    });
    return googleCalendarEventFromMcp(nestedRecord(payload, "event"), calendarId, params.timeZone);
  }

  async createEvent(params: GoogleCalendarEventInput): Promise<GoogleCalendarEvent> {
    throw new ElizaError(
      "Google Calendar MCP writes are unavailable because event reads do not expose an atomic provider version",
      {
        code: "GOOGLE_MCP_SAFE_CALENDAR_WRITE_UNSUPPORTED",
        context: { accountId: params.accountId, operation: "create_event" },
      }
    );
  }

  async updateEvent(params: GoogleCalendarEventPatchInput): Promise<GoogleCalendarEvent> {
    throw new ElizaError(
      "Google Calendar MCP writes are unavailable because event reads do not expose an atomic provider version",
      {
        code: "GOOGLE_MCP_SAFE_CALENDAR_WRITE_UNSUPPORTED",
        context: {
          accountId: params.accountId,
          eventId: params.eventId,
          operation: "update_event",
        },
      }
    );
  }

  async deleteEvent(params: GoogleCalendarEventDeleteInput): Promise<void> {
    throw new ElizaError(
      "Google Calendar MCP writes are unavailable because event reads do not expose an atomic provider version",
      {
        code: "GOOGLE_MCP_SAFE_CALENDAR_WRITE_UNSUPPORTED",
        context: {
          accountId: params.accountId,
          eventId: params.eventId,
          operation: "delete_event",
        },
      }
    );
  }

  async respondToEvent(params: GoogleCalendarEventResponseInput): Promise<GoogleCalendarEvent> {
    throw new ElizaError(
      "Google Calendar MCP responses are unavailable because event reads do not expose an atomic provider version",
      {
        code: "GOOGLE_MCP_SAFE_CALENDAR_WRITE_UNSUPPORTED",
        context: {
          accountId: params.accountId,
          eventId: params.eventId,
          operation: "respond_to_event",
        },
      }
    );
  }

  async searchFiles(
    params: GoogleAccountRef & { query: string; limit?: number }
  ): Promise<GoogleDriveFile[]> {
    return (
      await this.searchDriveFiles({
        accountId: params.accountId,
        query: params.query,
        maxResults: params.limit,
      })
    ).files;
  }

  async getFile(params: GoogleAccountRef & { fileId: string }): Promise<GoogleDriveFile> {
    const payload = await this.call(params.accountId, "drive", "get_file_metadata", {
      fileId: params.fileId,
    });
    return driveFile(nestedRecord(payload, "file"));
  }

  listDriveFiles(
    params: GoogleAccountRef & { folderId?: string; maxResults?: number; pageToken?: string }
  ): Promise<GoogleDriveFileList> {
    return this.searchDriveFiles({
      accountId: params.accountId,
      query: params.folderId ? `parentId = '${params.folderId}'` : "",
      maxResults: params.maxResults,
      pageToken: params.pageToken,
    });
  }

  async searchDriveFiles(
    params: GoogleAccountRef & { query: string; maxResults?: number; pageToken?: string }
  ): Promise<GoogleDriveFileList> {
    const payload = await this.call(params.accountId, "drive", "search_files", {
      ...(params.query ? { query: params.query } : {}),
      ...(params.maxResults ? { pageSize: params.maxResults } : {}),
      ...(params.pageToken ? { pageToken: params.pageToken } : {}),
    });
    return {
      files: (Array.isArray(payload.files) ? payload.files : []).map(driveFile),
      nextPageToken: optionalString(payload.nextPageToken) ?? null,
    };
  }

  async getDocContent(
    params: GoogleAccountRef & { documentId: string }
  ): Promise<GoogleDocContent> {
    const payload = await this.call(params.accountId, "docs", "read_doc", {
      documentId: params.documentId,
    });
    return {
      title: "Google Doc",
      plainText: optionalString(payload.content) ?? "",
    };
  }

  async getSheetContent(
    params: GoogleAccountRef & { spreadsheetId: string; range?: string }
  ): Promise<GoogleSheetContent> {
    const [metadata, values] = await Promise.all([
      this.call(params.accountId, "sheets", "get_spreadsheet", {
        spreadsheetId: params.spreadsheetId,
        includeGridData: false,
      }),
      this.call(params.accountId, "sheets", "get_values", {
        spreadsheetId: params.spreadsheetId,
        range: params.range ?? "A:ZZ",
      }),
    ]);
    const spreadsheet = nestedRecord(metadata, "spreadsheet");
    return {
      title:
        optionalString(
          isRecord(spreadsheet.properties) ? spreadsheet.properties.title : undefined
        ) ?? "Untitled",
      rows: (Array.isArray(values.values) ? values.values : []).map((row) =>
        Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : []
      ),
    };
  }

  async createDriveFile(params: GoogleDriveCreateFileInput): Promise<GoogleDriveFile> {
    const content = params.content;
    const arguments_: Record<string, unknown> = {
      title: params.name,
      contentMimeType: params.mimeType,
      ...(params.parentFolderId ? { parentId: params.parentFolderId } : {}),
    };
    if (typeof content === "string") arguments_.textContent = content;
    if (content instanceof Uint8Array) {
      arguments_.base64Content = Buffer.from(content).toString("base64");
    }
    const payload = await this.call(params.accountId, "drive", "create_file", arguments_);
    return driveFile(nestedRecord(payload, "file"));
  }

  async appendToDoc(
    params: GoogleAccountRef & { documentId: string; text: string }
  ): Promise<void> {
    throw new ElizaError("Official Docs MCP does not expose a safe append operation", {
      code: "GOOGLE_MCP_OPERATION_UNSUPPORTED",
      context: { documentId: params.documentId },
    });
  }

  async updateSheetCells(
    params: GoogleAccountRef & {
      spreadsheetId: string;
      range: string;
      values: ReadonlyArray<ReadonlyArray<string | number>>;
    }
  ): Promise<GoogleSheetUpdateResult> {
    const payload = await this.call(params.accountId, "sheets", "update_values", {
      spreadsheetId: params.spreadsheetId,
      range: params.range,
      values: params.values.map((row) => [...row]),
    });
    return {
      updatedRange: optionalString(payload.updatedRange) ?? params.range,
      updatedCells:
        typeof payload.updatedCells === "number"
          ? payload.updatedCells
          : params.values.reduce((count, row) => count + row.length, 0),
    };
  }
}
