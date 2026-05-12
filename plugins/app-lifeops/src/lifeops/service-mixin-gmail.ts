import crypto from "node:crypto";
import type {
  CreateLifeOpsGmailBatchReplyDraftsRequest,
  CreateLifeOpsGmailReplyDraftRequest,
  GetLifeOpsGmailRecommendationsRequest,
  GetLifeOpsGmailSearchRequest,
  GetLifeOpsGmailSpamReviewRequest,
  GetLifeOpsGmailTriageRequest,
  GetLifeOpsGmailUnrespondedRequest,
  IngestLifeOpsGmailEventRequest,
  LifeOpsConnectorGrant,
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
  LifeOpsGmailBatchReplyDraftsFeed,
  LifeOpsGmailBatchReplySendResult,
  LifeOpsGmailEventIngestResult,
  LifeOpsGmailManageResult,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailNeedsResponseFeed,
  LifeOpsGmailRecommendationsFeed,
  LifeOpsGmailReplyDraft,
  LifeOpsGmailSearchFeed,
  LifeOpsGmailSpamReviewFeed,
  LifeOpsGmailSpamReviewItem,
  LifeOpsGmailTriageFeed,
  LifeOpsGmailUnrespondedFeed,
  ManageLifeOpsGmailMessagesRequest,
  SendLifeOpsGmailBatchReplyRequest,
  SendLifeOpsGmailMessageRequest,
  SendLifeOpsGmailReplyRequest,
  UpdateLifeOpsGmailSpamReviewItemRequest,
} from "../contracts/index.js";
import {
  accountIdForGrant,
  googleSendEmailInput,
  lifeOpsGmailMessageFromGoogle,
  requireGoogleServiceMethod,
} from "./google-plugin-delegates.js";
import { createLifeOpsGmailSyncState } from "./repository.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";
import {
  fail,
  normalizeOptionalBoolean,
  normalizeOptionalString,
  requireNonEmptyString,
} from "./service-normalize.js";
import {
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "./service-normalize-connector.js";
import {
  normalizeGmailReplyBody,
  normalizeGmailDraftTone,
  normalizeGmailBulkOperation,
  normalizeOptionalGmailLabelIdArray,
  normalizeOptionalMessageIdArray,
  normalizeGmailSearchQuery,
  normalizeGmailSpamReviewStatus,
  normalizeGmailUnrespondedOlderThanDays,
  summarizeGmailBatchReplyDrafts,
  summarizeGmailNeedsResponse,
  summarizeGmailRecommendations,
  summarizeGmailSearch,
  summarizeGmailSpamReviewItems,
  summarizeGmailTriage,
  summarizeGmailUnresponded,
  buildFallbackGmailReplyDraftBody,
  buildGmailReplyDraft,
} from "./service-normalize-gmail.js";

export interface LifeOpsGmailService {
  getGmailTriage(
    requestUrl: URL,
    request?: GetLifeOpsGmailTriageRequest,
    now?: Date,
  ): Promise<LifeOpsGmailTriageFeed>;
  getGmailSearch(
    requestUrl: URL,
    request: GetLifeOpsGmailSearchRequest,
    now?: Date,
  ): Promise<LifeOpsGmailSearchFeed>;
  readGmailMessage(
    requestUrl: URL,
    request: {
      side?: LifeOpsConnectorSide;
      mode?: LifeOpsConnectorMode;
      grantId?: string;
      forceSync?: boolean;
      maxResults?: number;
      messageId?: string;
      query?: string;
      replyNeededOnly?: boolean;
    },
    now?: Date,
  ): Promise<{
    query: string | null;
    message: LifeOpsGmailMessageSummary;
    bodyText: string;
    source: "synced";
    syncedAt: string;
  }>;
  getGmailNeedsResponse(
    requestUrl: URL,
    request?: GetLifeOpsGmailTriageRequest,
    now?: Date,
  ): Promise<LifeOpsGmailNeedsResponseFeed>;
  getGmailRecommendations(
    requestUrl: URL,
    request?: GetLifeOpsGmailRecommendationsRequest,
    now?: Date,
  ): Promise<LifeOpsGmailRecommendationsFeed>;
  getGmailSpamReviewItems(
    requestUrl: URL,
    request?: GetLifeOpsGmailSpamReviewRequest,
  ): Promise<LifeOpsGmailSpamReviewFeed>;
  updateGmailSpamReviewItem(
    requestUrl: URL,
    itemId: string,
    request: UpdateLifeOpsGmailSpamReviewItemRequest,
    now?: Date,
  ): Promise<{ item: LifeOpsGmailSpamReviewItem }>;
  getGmailUnresponded(
    requestUrl: URL,
    request?: GetLifeOpsGmailUnrespondedRequest,
    now?: Date,
  ): Promise<LifeOpsGmailUnrespondedFeed>;
  manageGmailMessages(
    requestUrl: URL,
    request: ManageLifeOpsGmailMessagesRequest,
  ): Promise<LifeOpsGmailManageResult>;
  ingestGmailEvent(
    requestUrl: URL,
    request: IngestLifeOpsGmailEventRequest,
    now?: Date,
  ): Promise<LifeOpsGmailEventIngestResult>;
  createGmailBatchReplyDrafts(
    requestUrl: URL,
    request: CreateLifeOpsGmailBatchReplyDraftsRequest,
    now?: Date,
  ): Promise<LifeOpsGmailBatchReplyDraftsFeed>;
  createGmailReplyDraft(
    requestUrl: URL,
    request: CreateLifeOpsGmailReplyDraftRequest,
  ): Promise<LifeOpsGmailReplyDraft>;
  sendGmailReply(
    requestUrl: URL,
    request: SendLifeOpsGmailReplyRequest,
  ): Promise<{ ok: true }>;
  sendGmailMessage(
    requestUrl: URL,
    request: SendLifeOpsGmailMessageRequest,
  ): Promise<{ ok: true }>;
  sendGmailReplies(
    requestUrl: URL,
    request: SendLifeOpsGmailBatchReplyRequest,
  ): Promise<LifeOpsGmailBatchReplySendResult>;
}

const GOOGLE_GMAIL_MAILBOX = "me";
const DEFAULT_GMAIL_TRIAGE_MAX_RESULTS = 12;
const DEFAULT_GMAIL_SEARCH_LIMIT = 25;

type GmailMixinDependencies = LifeOpsServiceBase & {
  requireGoogleGmailGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant>;
  requireGoogleGmailSendGrant(
    requestUrl: URL,
    requestedMode?: LifeOpsConnectorMode,
    requestedSide?: LifeOpsConnectorSide,
    grantId?: string,
  ): Promise<LifeOpsConnectorGrant>;
};

function maxResults(value: unknown, fallback: number): number {
  return Math.max(
    1,
    Math.min(100, Number.isFinite(value) ? Math.trunc(value as number) : fallback),
  );
}

function bodyTextFromMessage(message: unknown): string {
  const record = message && typeof message === "object" ? message as Record<string, unknown> : {};
  const bodyText = typeof record.bodyText === "string" ? record.bodyText : "";
  const snippet = typeof record.snippet === "string" ? record.snippet : "";
  return bodyText || snippet;
}

function externalMessageIdFromInput(messageId: string): string {
  const marker = ":gmail:";
  const markerIndex = messageId.lastIndexOf(marker);
  if (markerIndex >= 0) {
    return messageId.slice(markerIndex + marker.length);
  }
  return messageId.startsWith("gmail:") ? messageId.slice("gmail:".length) : messageId;
}

function isDestructiveGmailOperation(operation: string): boolean {
  return operation === "trash" || operation === "delete" || operation === "report_spam";
}

function labelsAfterGmailManage(
  labels: readonly string[],
  operation: string,
  labelIds: readonly string[],
): string[] {
  const next = new Set(labels);
  const add = (value: string) => next.add(value);
  const remove = (value: string) => next.delete(value);
  switch (operation) {
    case "archive":
      remove("INBOX");
      break;
    case "trash":
      add("TRASH");
      remove("INBOX");
      break;
    case "report_spam":
      add("SPAM");
      remove("INBOX");
      break;
    case "mark_read":
      remove("UNREAD");
      break;
    case "mark_unread":
      add("UNREAD");
      break;
    case "apply_label":
      labelIds.forEach(add);
      break;
    case "remove_label":
      labelIds.forEach(remove);
      break;
  }
  return [...next];
}

function draftForMessage(
  message: LifeOpsGmailMessageSummary,
  args: {
    intent?: string;
    tone?: "brief" | "neutral" | "warm";
    includeQuotedOriginal?: boolean;
    senderName?: string;
  } = {},
): LifeOpsGmailReplyDraft {
  const bodyText = buildFallbackGmailReplyDraftBody({
    message,
    tone: args.tone ?? "neutral",
    intent: args.intent,
    includeQuotedOriginal: args.includeQuotedOriginal ?? false,
    senderName: args.senderName ?? "",
  });
  return buildGmailReplyDraft({
    message,
    senderName: args.senderName ?? "",
    sendAllowed: true,
    bodyText,
  });
}

/** @internal */
export function withGmail<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsGmailService> {
  const GmailBase = Base as unknown as Constructor<GmailMixinDependencies>;

  return class extends GmailBase {
    private async syncGmailMessages(args: {
      requestUrl: URL;
      mode?: LifeOpsConnectorMode;
      side?: LifeOpsConnectorSide;
      grantId?: string;
      query: string;
      maxResults: number;
      now?: Date;
    }): Promise<{
      grant: LifeOpsConnectorGrant;
      query: string;
      messages: LifeOpsGmailMessageSummary[];
      syncedAt: string;
    }> {
      const grant = await this.requireGoogleGmailGrant(
        args.requestUrl,
        args.mode,
        args.side,
        args.grantId,
      );
      const searchMessages = requireGoogleServiceMethod(this.runtime, "searchMessages");
      const syncedAt = (args.now ?? new Date()).toISOString();
      const googleMessages = await searchMessages({
        accountId: accountIdForGrant(grant),
        query: args.query,
        limit: args.maxResults,
      });
      const messages = googleMessages.map((message) =>
        lifeOpsGmailMessageFromGoogle({
          message,
          grant,
          agentId: this.agentId(),
          syncedAt,
        }),
      );
      for (const message of messages) {
        await this.repository.upsertGmailMessage(message, grant.side);
      }
      await this.repository.upsertGmailSyncState(
        createLifeOpsGmailSyncState({
          agentId: this.agentId(),
          provider: "google",
          side: grant.side,
          mailbox: GOOGLE_GMAIL_MAILBOX,
          grantId: grant.id,
          maxResults: args.maxResults,
          syncedAt,
        }),
      );
      return { grant, query: args.query, messages, syncedAt };
    }

    async getGmailTriage(
      requestUrl: URL,
      request: GetLifeOpsGmailTriageRequest = {},
      now = new Date(),
    ): Promise<LifeOpsGmailTriageFeed> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const limit = maxResults(request.maxResults, DEFAULT_GMAIL_TRIAGE_MAX_RESULTS);
      const synced = await this.syncGmailMessages({
        requestUrl,
        mode,
        side,
        grantId: request.grantId,
        query: "in:inbox newer_than:30d",
        maxResults: limit,
        now,
      });
      return {
        messages: synced.messages,
        source: "synced",
        syncedAt: synced.syncedAt,
        summary: summarizeGmailTriage(synced.messages),
      };
    }

    async getGmailSearch(
      requestUrl: URL,
      request: GetLifeOpsGmailSearchRequest,
      now = new Date(),
    ): Promise<LifeOpsGmailSearchFeed> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const query = normalizeGmailSearchQuery(request.query);
      const limit = maxResults(request.maxResults, DEFAULT_GMAIL_SEARCH_LIMIT);
      const synced = await this.syncGmailMessages({
        requestUrl,
        mode,
        side,
        grantId: request.grantId,
        query: request.includeSpamTrash ? `${query} in:anywhere` : query,
        maxResults: limit,
        now,
      });
      const messages = request.replyNeededOnly
        ? synced.messages.filter((message) => message.likelyReplyNeeded)
        : synced.messages;
      return {
        query,
        messages,
        source: "synced",
        syncedAt: synced.syncedAt,
        summary: summarizeGmailSearch(messages),
      };
    }

    async readGmailMessage(
      requestUrl: URL,
      request: {
        side?: LifeOpsConnectorSide;
        mode?: LifeOpsConnectorMode;
        grantId?: string;
        messageId?: string;
        query?: string;
      },
      now = new Date(),
    ): Promise<{
      query: string | null;
      message: LifeOpsGmailMessageSummary;
      bodyText: string;
      source: "synced";
      syncedAt: string;
    }> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const grant = await this.requireGoogleGmailGrant(
        requestUrl,
        mode,
        side,
        request.grantId,
      );
      const getMessage = requireGoogleServiceMethod(this.runtime, "getMessage");
      let messageId = normalizeOptionalString(request.messageId);
      if (messageId) {
        messageId = externalMessageIdFromInput(messageId);
      }
      let query: string | null = null;
      if (!messageId) {
        query = normalizeGmailSearchQuery(request.query ?? "in:inbox newer_than:30d");
        const search = await this.getGmailSearch(
          requestUrl,
          {
            mode,
            side,
            grantId: request.grantId,
            query,
            maxResults: 1,
          },
          now,
        );
        messageId = search.messages[0]?.externalId ?? null;
      }
      if (!messageId) {
        fail(404, "No Gmail message matched the request.");
      }
      const googleMessage = await getMessage({
        accountId: accountIdForGrant(grant),
        messageId,
        includeBody: true,
      });
      const syncedAt = now.toISOString();
      const message = lifeOpsGmailMessageFromGoogle({
        message: googleMessage,
        grant,
        agentId: this.agentId(),
        syncedAt,
      });
      await this.repository.upsertGmailMessage(message, grant.side);
      return {
        query,
        message,
        bodyText: bodyTextFromMessage(googleMessage),
        source: "synced",
        syncedAt,
      };
    }

    async getGmailNeedsResponse(
      requestUrl: URL,
      request: GetLifeOpsGmailTriageRequest = {},
      now = new Date(),
    ): Promise<LifeOpsGmailNeedsResponseFeed> {
      const triage = await this.getGmailTriage(requestUrl, request, now);
      const messages = triage.messages.filter((message) => message.likelyReplyNeeded);
      return {
        messages,
        source: "synced",
        syncedAt: triage.syncedAt,
        summary: summarizeGmailNeedsResponse(messages),
      };
    }

    async getGmailRecommendations(
      requestUrl: URL,
      request: GetLifeOpsGmailRecommendationsRequest = {},
      now = new Date(),
    ): Promise<LifeOpsGmailRecommendationsFeed> {
      const triage = await this.getGmailTriage(
        requestUrl,
        {
          side: request.side,
          mode: request.mode,
          grantId: request.grantId,
          forceSync: request.forceSync,
          maxResults: request.maxResults,
        },
        now,
      );
      return {
        recommendations: [],
        messages: triage.messages,
        source: "synced",
        syncedAt: triage.syncedAt,
        summary: summarizeGmailRecommendations([]),
      } as LifeOpsGmailRecommendationsFeed & {
        messages: LifeOpsGmailMessageSummary[];
      };
    }

    async getGmailSpamReviewItems(
      _requestUrl: URL,
      request: GetLifeOpsGmailSpamReviewRequest = {},
    ): Promise<LifeOpsGmailSpamReviewFeed> {
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const status = request.status
        ? normalizeGmailSpamReviewStatus(request.status)
        : undefined;
      const items = await this.repository.listGmailSpamReviewItems(
        this.agentId(),
        "google",
        {
          status,
          maxResults: maxResults(request.maxResults, 100),
          grantId: request.grantId,
        },
        side,
      );
      return { items, summary: summarizeGmailSpamReviewItems(items) };
    }

    async updateGmailSpamReviewItem(
      _requestUrl: URL,
      itemId: string,
      request: UpdateLifeOpsGmailSpamReviewItemRequest,
      now = new Date(),
    ): Promise<{ item: LifeOpsGmailSpamReviewItem }> {
      const status = normalizeGmailSpamReviewStatus(request.status);
      await this.repository.updateGmailSpamReviewItemStatus(
        this.agentId(),
        "google",
        requireNonEmptyString(itemId, "itemId"),
        status,
        status === "pending" ? null : now.toISOString(),
        now.toISOString(),
      );
      const item = await this.repository.getGmailSpamReviewItem(
        this.agentId(),
        "google",
        itemId,
      );
      if (!item) {
        fail(404, "Gmail spam review item not found.");
      }
      return { item };
    }

    async getGmailUnresponded(
      requestUrl: URL,
      request: GetLifeOpsGmailUnrespondedRequest = {},
      now = new Date(),
    ): Promise<LifeOpsGmailUnrespondedFeed> {
      const olderThanDays = normalizeGmailUnrespondedOlderThanDays(
        request.olderThanDays,
      );
      const query = `in:sent older_than:${olderThanDays}d`;
      const synced = await this.syncGmailMessages({
        requestUrl,
        mode: normalizeOptionalConnectorMode(request.mode, "mode"),
        side: normalizeOptionalConnectorSide(request.side, "side"),
        grantId: request.grantId,
        query,
        maxResults: maxResults(request.maxResults, 25),
        now,
      });
      const threads = synced.messages.map((message) => ({
        threadId: message.threadId,
        messageId: message.id,
        subject: message.subject,
        to: message.to,
        cc: message.cc,
        lastOutboundAt: message.receivedAt,
        lastInboundAt: null,
        daysWaiting: Math.max(
          olderThanDays,
          Math.floor((now.getTime() - Date.parse(message.receivedAt)) / 86_400_000),
        ),
        snippet: message.snippet,
        labels: message.labels,
        htmlLink: message.htmlLink,
        grantId: message.grantId,
        accountEmail: message.accountEmail,
      }));
      return {
        threads,
        source: "synced",
        syncedAt: synced.syncedAt,
        summary: summarizeGmailUnresponded(threads),
      };
    }

    async manageGmailMessages(
      requestUrl: URL,
      request: ManageLifeOpsGmailMessagesRequest,
    ): Promise<LifeOpsGmailManageResult> {
      const mode = normalizeOptionalConnectorMode(request.mode, "mode");
      const side = normalizeOptionalConnectorSide(request.side, "side");
      const grantId = normalizeOptionalString(request.grantId);
      const operation = normalizeGmailBulkOperation(request.operation);
      const messageIds =
        normalizeOptionalMessageIdArray(request.messageIds, "messageIds") ?? [];
      const query =
        request.query === undefined || request.query === null
          ? null
          : normalizeGmailSearchQuery(request.query);
      const labelIds =
        normalizeOptionalGmailLabelIdArray(request.labelIds, "labelIds") ?? [];
      const destructive = isDestructiveGmailOperation(operation);
      const confirmDestructive =
        normalizeOptionalBoolean(request.confirmDestructive, "confirmDestructive") ??
        false;

      if (destructive && !confirmDestructive) {
        fail(409, `${operation} requires explicit destructive confirmation.`);
      }
      if (
        (operation === "apply_label" || operation === "remove_label") &&
        labelIds.length === 0
      ) {
        fail(400, `${operation} requires at least one Gmail label id.`);
      }
      if (messageIds.length === 0 && !query) {
        fail(400, "Gmail management requires messageIds or query.");
      }

      const grant = await this.requireGoogleGmailGrant(
        requestUrl,
        mode,
        side,
        grantId,
      );
      if (!grant.capabilities.includes("google.gmail.manage")) {
        fail(
          403,
          "Gmail management access has not been granted. Reconnect Google through @elizaos/plugin-google with Gmail manage scope.",
        );
      }

      const max = maxResults(request.maxResults, DEFAULT_GMAIL_SEARCH_LIMIT);
      const messages: LifeOpsGmailMessageSummary[] =
        messageIds.length > 0
          ? await Promise.all(
              messageIds.map(async (messageId) => {
                const cached = await this.repository.getGmailMessage(
                  this.agentId(),
                  "google",
                  messageId,
                  grant.side,
                  grant.id,
                );
                if (cached) {
                  return cached;
                }
                const externalId = externalMessageIdFromInput(messageId);
                return {
                  id: messageId,
                  externalId,
                  agentId: this.agentId(),
                  provider: "google",
                  side: grant.side,
                  threadId: externalId,
                  subject: "",
                  from: "",
                  fromEmail: null,
                  replyTo: null,
                  to: [],
                  cc: [],
                  snippet: "",
                  receivedAt: new Date().toISOString(),
                  isUnread: false,
                  isImportant: false,
                  likelyReplyNeeded: false,
                  triageScore: 0,
                  triageReason: "",
                  labels: [],
                  htmlLink: null,
                  metadata: {},
                  syncedAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  connectorAccountId: grant.connectorAccountId ?? undefined,
                  grantId: grant.id,
                  accountEmail: grant.identityEmail ?? undefined,
                };
              }),
            )
          : (
              await this.getGmailSearch(
                requestUrl,
                {
                  mode,
                  side,
                  grantId: grant.id,
                  query,
                  maxResults: max,
                  includeSpamTrash: true,
                },
              )
            ).messages;

      if (messages.length === 0) {
        fail(404, "No Gmail messages matched the requested operation.");
      }

      const executionMode = request.executionMode ?? "execute";
      const status =
        executionMode === "proposal"
          ? "proposed"
          : executionMode === "dry_run"
            ? "dry_run"
            : "executed";

      if (executionMode === "execute") {
        const modifyGmailMessages = requireGoogleServiceMethod(
          this.runtime,
          "modifyGmailMessages",
        );
        await modifyGmailMessages({
          accountId: accountIdForGrant(grant),
          messageIds: messages.map((message) => message.externalId),
          operation,
          labelIds,
        });

        if (operation === "delete") {
          await this.repository.deleteGmailMessages(
            this.agentId(),
            "google",
            messages.map((message) => message.id),
            grant.side,
            grant.id,
          );
        } else {
          for (const message of messages) {
            const labels = labelsAfterGmailManage(message.labels, operation, labelIds);
            await this.repository.upsertGmailMessage(
              {
                ...message,
                labels,
                isUnread: labels.includes("UNREAD"),
                updatedAt: new Date().toISOString(),
              },
              grant.side,
            );
          }
        }
      }

      await this.recordConnectorAudit(
        grant.id,
        "gmail messages managed through plugin-google",
        {
          operation,
          query,
          messageIds: messages.map((message) => message.id),
          labelIds,
          executionMode,
        },
        {
          affectedCount: messages.length,
          destructive,
          connectorAccountId: grant.connectorAccountId ?? null,
        },
      );

      return {
        ok: true,
        operation,
        messageIds: messages.map((message) => message.id),
        affectedCount: messages.length,
        labelIds,
        destructive,
        grantId: grant.id,
        accountEmail: grant.identityEmail ?? undefined,
        executionMode,
        status,
        reason: request.reason,
        approval: request.approval,
        plan: request.plan,
        selectedMessageSnapshots: request.selectedMessageSnapshots,
        chunk: request.chunk
          ? {
              chunkId: request.chunk.chunkId,
              chunkIndex: request.chunk.chunkIndex,
              chunkCount: request.chunk.chunkCount,
              processedCount: messages.length,
              remainingCount: 0,
              nextCursor: null,
            }
          : undefined,
        audit: request.audit
          ? {
              auditEventId: request.audit.auditEventId ?? null,
              auditRef: request.audit.auditRef ?? null,
              actor: request.audit.actor ?? "user",
              recordedAt: new Date().toISOString(),
            }
          : undefined,
        undo: request.undo
          ? {
              status: "not_available",
              undoId: request.undo.undoId,
              undoExpiresAt: null,
              auditEventId: request.undo.auditEventId ?? null,
              messageIds: messages.map((message) => message.id),
            }
          : undefined,
      };
    }

    async ingestGmailEvent(
      requestUrl: URL,
      request: IngestLifeOpsGmailEventRequest,
      now = new Date(),
    ): Promise<LifeOpsGmailEventIngestResult> {
      const read = await this.readGmailMessage(
        requestUrl,
        {
          mode: request.mode,
          side: request.side,
          grantId: request.grantId,
          messageId: request.messageId,
        },
        now,
      );
      return {
        ok: true,
        event: {
          id: crypto.randomUUID(),
          kind: request.eventKind ?? "gmail.message.received",
          occurredAt: request.occurredAt ?? now.toISOString(),
          payload: {
            messageId: read.message.id,
            externalMessageId: read.message.externalId,
            threadId: read.message.threadId,
            subject: read.message.subject,
            from: read.message.from,
          },
        },
        workflowRunIds: [],
      };
    }

    async createGmailReplyDraft(
      requestUrl: URL,
      request: CreateLifeOpsGmailReplyDraftRequest,
    ): Promise<LifeOpsGmailReplyDraft> {
      const tone = normalizeGmailDraftTone(request.tone);
      const intent = normalizeOptionalString(request.intent);
      const includeQuotedOriginal =
        normalizeOptionalBoolean(request.includeQuotedOriginal, "includeQuotedOriginal") ??
        false;
      const read = await this.readGmailMessage(requestUrl, {
        mode: request.mode,
        side: request.side,
        grantId: request.grantId,
        messageId: request.messageId,
      });
      return draftForMessage(read.message, {
        tone,
        intent,
        includeQuotedOriginal,
      });
    }

    async createGmailBatchReplyDrafts(
      requestUrl: URL,
      request: CreateLifeOpsGmailBatchReplyDraftsRequest,
      now = new Date(),
    ): Promise<LifeOpsGmailBatchReplyDraftsFeed> {
      const messages = request.messageIds?.length
        ? await Promise.all(
            request.messageIds.map(async (messageId) => (
              await this.readGmailMessage(
                requestUrl,
                {
                  mode: request.mode,
                  side: request.side,
                  grantId: request.grantId,
                  messageId,
                },
                now,
              )
            ).message),
          )
        : (
            await this.getGmailSearch(
              requestUrl,
              {
                mode: request.mode,
                side: request.side,
                grantId: request.grantId,
                query: request.query ?? "in:inbox newer_than:30d",
                maxResults: request.maxResults,
                replyNeededOnly: request.replyNeededOnly,
              },
              now,
            )
          ).messages;
      const tone = normalizeGmailDraftTone(request.tone);
      const intent = normalizeOptionalString(request.intent);
      const includeQuotedOriginal =
        normalizeOptionalBoolean(request.includeQuotedOriginal, "includeQuotedOriginal") ??
        false;
      const drafts = messages.map((message) =>
        draftForMessage(message, {
          tone,
          intent,
          includeQuotedOriginal,
        }),
      );
      return {
        query: request.query ?? null,
        messages,
        drafts,
        source: "synced",
        syncedAt: now.toISOString(),
        summary: summarizeGmailBatchReplyDrafts(drafts),
      };
    }

    async sendGmailReply(
      requestUrl: URL,
      request: SendLifeOpsGmailReplyRequest,
    ): Promise<{ ok: true }> {
      const confirmed =
        normalizeOptionalBoolean(request.confirmSend, "confirmSend") ?? false;
      if (!confirmed) {
        fail(409, "Gmail reply send requires confirmSend=true.");
      }
      const read = await this.readGmailMessage(requestUrl, {
        mode: request.mode,
        side: request.side,
        grantId: request.grantId,
        messageId: request.messageId,
      });
      const grant = await this.requireGoogleGmailSendGrant(
        requestUrl,
        request.mode,
        request.side,
        request.grantId,
      );
      const sendEmail = requireGoogleServiceMethod(this.runtime, "sendEmail");
      await sendEmail(
        googleSendEmailInput({
          accountId: accountIdForGrant(grant),
          to: request.to?.length ? request.to : read.message.fromEmail ? [read.message.fromEmail] : [],
          cc: request.cc,
          subject: request.subject ?? `Re: ${read.message.subject.replace(/^Re:\\s*/i, "")}`,
          bodyText: normalizeGmailReplyBody(request.bodyText),
          threadId: read.message.threadId,
        }),
      );
      return { ok: true };
    }

    async sendGmailMessage(
      requestUrl: URL,
      request: SendLifeOpsGmailMessageRequest,
    ): Promise<{ ok: true }> {
      const confirmed =
        normalizeOptionalBoolean(request.confirmSend, "confirmSend") ?? false;
      if (!confirmed) {
        fail(409, "Gmail message send requires confirmSend=true.");
      }
      const grant = await this.requireGoogleGmailSendGrant(
        requestUrl,
        request.mode,
        request.side,
        request.grantId,
      );
      const sendEmail = requireGoogleServiceMethod(this.runtime, "sendEmail");
      await sendEmail(
        googleSendEmailInput({
          accountId: accountIdForGrant(grant),
          to: request.to,
          cc: request.cc,
          bcc: request.bcc,
          subject: requireNonEmptyString(request.subject, "subject"),
          bodyText: normalizeGmailReplyBody(request.bodyText),
        }),
      );
      return { ok: true };
    }

    async sendGmailReplies(
      requestUrl: URL,
      request: SendLifeOpsGmailBatchReplyRequest,
    ): Promise<LifeOpsGmailBatchReplySendResult> {
      const confirmed =
        normalizeOptionalBoolean(request.confirmSend, "confirmSend") ?? false;
      if (!confirmed) {
        fail(409, "Batch Gmail reply send requires confirmSend=true.");
      }
      for (const item of request.items ?? []) {
        await this.sendGmailReply(requestUrl, {
          mode: request.mode,
          side: request.side,
          grantId: request.grantId,
          messageId: item.messageId,
          bodyText: item.bodyText,
          subject: item.subject,
          to: item.to,
          cc: item.cc,
          confirmSend: true,
        });
      }
      return { ok: true, sentCount: request.items?.length ?? 0 };
    }
  } as unknown as MixinClass<TBase, LifeOpsGmailService>;
}
