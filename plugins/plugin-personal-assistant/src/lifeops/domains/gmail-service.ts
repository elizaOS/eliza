/**
 * Gmail domain for LifeOps: the assistant's inbox-triage surface over the
 * owner's Gmail — search, unresponded/needs-response feeds, spam review, reply
 * drafting and batch sends. Projects `@elizaos/plugin-google-workspace` results into
 * assistant DTOs; the actual Gmail API access lives in the google plugin.
 */
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
  LifeOpsGmailImportedDataPurgeReceipt,
  LifeOpsGmailManageResult,
  LifeOpsGmailMessageSummary,
  LifeOpsGmailNeedsResponseFeed,
  LifeOpsGmailRecommendationsFeed,
  LifeOpsGmailReplyDraft,
  LifeOpsGmailSearchFeed,
  LifeOpsGmailSeedRangeDays,
  LifeOpsGmailSeedReceipt,
  LifeOpsGmailSpamReviewFeed,
  LifeOpsGmailSpamReviewItem,
  LifeOpsGmailSyncHealth,
  LifeOpsGmailTriageFeed,
  LifeOpsGmailUnrespondedFeed,
  ManageLifeOpsGmailMessagesRequest,
  PurgeLifeOpsGmailImportedDataRequest,
  SeedLifeOpsGmailRequest,
  SendLifeOpsGmailBatchReplyRequest,
  SendLifeOpsGmailMessageRequest,
  SendLifeOpsGmailReplyRequest,
  UpdateLifeOpsGmailSpamReviewItemRequest,
} from "../../contracts/index.js";
import { settleBriefEngagementReward } from "../briefing/engagement-reward.js";
import {
  accountIdForGrant,
  googleAccountIdFromGrantId,
  googleSendEmailInput,
  lifeOpsGmailMessageFromGoogle,
  requireGoogleServiceMethod,
} from "../google-plugin-delegates.js";
import type { LifeOpsContext } from "../lifeops-context.js";
import { createLifeOpsGmailSyncState } from "../repository.js";
import {
  fail,
  normalizeOptionalBoolean,
  normalizeOptionalString,
  requireNonEmptyString,
} from "../service-normalize.js";
import {
  normalizeOptionalConnectorMode,
  normalizeOptionalConnectorSide,
} from "../service-normalize-connector.js";
import {
  buildFallbackGmailReplyDraftBody,
  buildGmailReplyDraft,
  normalizeGmailBulkOperation,
  normalizeGmailDraftTone,
  normalizeGmailReplyBody,
  normalizeGmailSearchQuery,
  normalizeGmailSpamReviewStatus,
  normalizeGmailUnrespondedOlderThanDays,
  normalizeOptionalGmailLabelIdArray,
  normalizeOptionalMessageIdArray,
  summarizeGmailBatchReplyDrafts,
  summarizeGmailNeedsResponse,
  summarizeGmailRecommendations,
  summarizeGmailSearch,
  summarizeGmailSpamReviewItems,
  summarizeGmailTriage,
  summarizeGmailUnresponded,
} from "../service-normalize-gmail.js";

const GOOGLE_GMAIL_MAILBOX = "me";
const DEFAULT_GMAIL_TRIAGE_MAX_RESULTS = 12;
const DEFAULT_GMAIL_SEARCH_LIMIT = 25;
const GMAIL_SEED_PAGE_SIZE = 100;
// A seed walks provider pages until Gmail stops returning a token. This cap
// only bounds runaway pagination; reaching it fails the seed explicitly rather
// than issuing a receipt for a range that was not fully imported.
const GMAIL_SEED_MAX_PAGES = 500;
const GMAIL_SEED_RANGE_DAYS: readonly LifeOpsGmailSeedRangeDays[] = [7, 30, 90];

/**
 * Dependencies the Gmail domain needs that are owned by the `google` domain
 * (`withGoogle`) rather than living on {@link LifeOpsContext}. They are injected
 * as typed callbacks wired from the composed service instance.
 */
type GmailDomainDeps = {
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

function explicitMaxResults(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || (value as number) <= 0) {
    fail(400, "maxResults must be a positive integer when provided.");
  }
  return value as number;
}

function bodyTextFromMessage(message: unknown): string {
  const record =
    message && typeof message === "object"
      ? (message as Record<string, unknown>)
      : {};
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
  return messageId.startsWith("gmail:")
    ? messageId.slice("gmail:".length)
    : messageId;
}

function gmailHeader(
  message: LifeOpsGmailMessageSummary,
  name: string,
): string | null {
  const target = name.toLowerCase();
  const richHeader =
    target === "message-id"
      ? message.metadata.messageIdHeader
      : target === "references"
        ? message.metadata.referencesHeader
        : null;
  if (typeof richHeader === "string" && richHeader.trim()) {
    return richHeader.trim();
  }
  const headers = message.metadata.headers;
  if (!headers || typeof headers !== "object" || Array.isArray(headers))
    return null;
  for (const [key, value] of Object.entries(
    headers as Record<string, unknown>,
  )) {
    if (
      key.toLowerCase() === target &&
      typeof value === "string" &&
      value.trim()
    ) {
      return value.trim();
    }
  }
  return null;
}

/** Canonical source id emitted by GoogleGmailAdapter into BRIEF's MessageRef. */
export function gmailBriefSourceId(externalMessageId: string): string {
  return `gmail:${externalMessageIdFromInput(externalMessageId)}`;
}

function isDestructiveGmailOperation(operation: string): boolean {
  return (
    operation === "trash" ||
    operation === "delete" ||
    operation === "report_spam"
  );
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

/**
 * Gmail triage, search, drafting, and send/manage flows backed by
 * `@elizaos/plugin-google-workspace`. Depends on the `google` domain's grant resolution
 * (`requireGoogleGmailGrant` / `requireGoogleGmailSendGrant`) injected via
 * {@link GmailDomainDeps}.
 */
export class GmailDomain {
  constructor(
    private readonly ctx: LifeOpsContext,
    private readonly deps: GmailDomainDeps,
  ) {}

  private async attributeBriefMessageOutcome(args: {
    messageId: string;
    eventType: "opened" | "replied";
    domainEventId: string;
    weight: number;
  }): Promise<void> {
    const eventAt = new Date().toISOString();
    try {
      const engagement = await this.ctx.repository.attributeBriefItemEngagement(
        {
          agentId: this.ctx.agentId(),
          source: "inbox",
          sourceId: args.messageId,
          eventType: args.eventType,
          eventAt,
          domainEventId: args.domainEventId,
          weight: args.weight,
        },
      );
      if (engagement) {
        await settleBriefEngagementReward({
          runtime: this.ctx.runtime,
          repository: this.ctx.repository,
          engagement,
        });
      }
    } catch (error) {
      // error-policy:J7 the Gmail mutation already committed; learning state
      // is durable/retryable and cannot change the connector result.
      this.ctx.runtime.reportError("GmailDomain.attributeBriefOutcome", error, {
        messageId: args.messageId,
        eventType: args.eventType,
      });
    }
  }

  private async syncGmailMessages(args: {
    requestUrl: URL;
    mode?: LifeOpsConnectorMode;
    side?: LifeOpsConnectorSide;
    grantId?: string;
    query: string;
    maxResults?: number;
    now?: Date;
  }): Promise<{
    grant: LifeOpsConnectorGrant;
    query: string;
    messages: LifeOpsGmailMessageSummary[];
    syncedAt: string;
  }> {
    const grant = await this.deps.requireGoogleGmailGrant(
      args.requestUrl,
      args.mode,
      args.side,
      args.grantId,
    );
    const accountId = accountIdForGrant(grant);
    const searchMessages = requireGoogleServiceMethod(
      this.ctx.runtime,
      "searchGmailMessages",
    );
    const getGmailMessage = requireGoogleServiceMethod(
      this.ctx.runtime,
      "getGmailMessage",
    );
    const getGmailHistoryId = requireGoogleServiceMethod(
      this.ctx.runtime,
      "getGmailHistoryId",
    );
    const listGmailHistoryPage = requireGoogleServiceMethod(
      this.ctx.runtime,
      "listGmailHistoryPage",
    );
    const syncedAt = (args.now ?? new Date()).toISOString();
    const previousState = await this.ctx.repository.getGmailSyncState(
      this.ctx.agentId(),
      "google",
      GOOGLE_GMAIL_MAILBOX,
      grant.side,
      grant.id,
    );
    let historyId = previousState?.historyId ?? null;
    if (previousState?.fullResyncReason && !historyId) {
      fail(
        409,
        "Gmail history requires a new complete 7, 30, or 90 day seed before the imported projection can be synchronized.",
        "LIFEOPS_GMAIL_RESYNC_REQUIRED",
      );
    }
    const cursorStatus: "seeded" | "incremental" | "resynced" = historyId
      ? "incremental"
      : "seeded";
    const fullResyncReason: string | null = null;

    if (historyId) {
      const startHistoryId = historyId;
      let nextHistoryId = historyId;
      const actions = new Map<string, "upsert" | "delete">();
      const seenPageTokens = new Set<string>();
      let pageToken: string | undefined;
      try {
        do {
          const page = await listGmailHistoryPage({
            accountId,
            startHistoryId,
            pageToken,
          });
          for (const change of page.changes) {
            for (const item of [
              ...change.messagesAdded,
              ...change.labelsAdded,
              ...change.labelsRemoved,
            ]) {
              actions.set(item.messageId, "upsert");
            }
            for (const item of change.messagesDeleted) {
              actions.set(item.messageId, "delete");
            }
          }
          nextHistoryId = page.historyId;
          pageToken = page.nextPageToken ?? undefined;
          if (pageToken) {
            if (seenPageTokens.has(pageToken)) {
              throw new Error(
                "Gmail history pagination repeated a page token.",
              );
            }
            seenPageTokens.add(pageToken);
          }
        } while (pageToken);

        historyId = nextHistoryId;

        for (const [externalId, action] of actions) {
          if (action === "delete") {
            await this.ctx.repository.deleteGmailMessagesByExternalId(
              this.ctx.agentId(),
              "google",
              [externalId],
              grant.side,
              grant.id,
            );
            continue;
          }
          const changed = await getGmailMessage({
            accountId,
            messageId: externalId,
            selfEmail: grant.identityEmail,
          });
          if (!changed) {
            await this.ctx.repository.deleteGmailMessagesByExternalId(
              this.ctx.agentId(),
              "google",
              [externalId],
              grant.side,
              grant.id,
            );
            continue;
          }
          await this.ctx.repository.upsertGmailMessage(
            lifeOpsGmailMessageFromGoogle({
              message: changed,
              grant,
              agentId: this.ctx.agentId(),
              syncedAt,
            }),
            grant.side,
          );
        }
      } catch (error) {
        // error-policy:J4 Only the typed expired-cursor signal becomes an
        // explicit resync-required state. A bounded query cannot reconcile
        // deletions from the complete imported projection, so it must not
        // advance a replacement cursor or claim a healthy automatic resync.
        const code =
          error && typeof error === "object" && "code" in error
            ? (error as { code?: unknown }).code
            : null;
        if (code !== "GOOGLE_GMAIL_HISTORY_CURSOR_EXPIRED") {
          throw error;
        }
        await this.ctx.repository.upsertGmailSyncState(
          createLifeOpsGmailSyncState({
            agentId: this.ctx.agentId(),
            provider: "google",
            side: grant.side,
            mailbox: GOOGLE_GMAIL_MAILBOX,
            grantId: grant.id,
            maxResults: previousState?.maxResults ?? 0,
            historyId: null,
            cursorStatus: "resynced",
            fullResyncReason: "history_cursor_expired",
            syncedAt,
          }),
        );
        fail(
          409,
          "Gmail history expired and the imported projection requires a new complete 7, 30, or 90 day seed before it can be reported as current.",
          "LIFEOPS_GMAIL_RESYNC_REQUIRED",
        );
      }
    }

    if (!historyId) {
      historyId = await getGmailHistoryId({ accountId });
    }
    const googleMessages = await searchMessages({
      accountId,
      query: args.query,
      maxResults: args.maxResults,
      selfEmail: grant.identityEmail,
    });
    const messages = googleMessages.map((message) =>
      lifeOpsGmailMessageFromGoogle({
        message,
        grant,
        agentId: this.ctx.agentId(),
        syncedAt,
      }),
    );
    for (const message of messages) {
      await this.ctx.repository.upsertGmailMessage(message, grant.side);
    }
    await this.ctx.repository.upsertGmailSyncState(
      createLifeOpsGmailSyncState({
        agentId: this.ctx.agentId(),
        provider: "google",
        side: grant.side,
        mailbox: GOOGLE_GMAIL_MAILBOX,
        grantId: grant.id,
        maxResults: args.maxResults,
        historyId,
        cursorStatus,
        fullResyncReason,
        syncedAt,
      }),
    );
    return { grant, query: args.query, messages, syncedAt };
  }

  /**
   * Imports every message the provider reports for `newer_than:<rangeDays>d`
   * into the local projection and resets the History cursor to the instant
   * captured before the walk began. Unlike the bounded triage/search syncs,
   * there is no result ceiling: either the whole range is imported and a
   * receipt is issued, or the seed fails with a typed error and no receipt.
   */
  async seedGmailMessages(
    requestUrl: URL,
    request: SeedLifeOpsGmailRequest,
    now = new Date(),
  ): Promise<LifeOpsGmailSeedReceipt> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const grantId = requireNonEmptyString(request.grantId, "grantId");
    const rangeDays = request.rangeDays;
    if (!GMAIL_SEED_RANGE_DAYS.includes(rangeDays)) {
      fail(
        400,
        `rangeDays must be one of ${GMAIL_SEED_RANGE_DAYS.join(", ")}.`,
        "LIFEOPS_GMAIL_SEED_RANGE_INVALID",
      );
    }
    const grant = await this.deps.requireGoogleGmailGrant(
      requestUrl,
      mode,
      side,
      grantId,
    );
    const accountId = accountIdForGrant(grant);
    const getGmailHistoryId = requireGoogleServiceMethod(
      this.ctx.runtime,
      "getGmailHistoryId",
    );
    const searchGmailMessagesPage = requireGoogleServiceMethod(
      this.ctx.runtime,
      "searchGmailMessagesPage",
    );
    const query = `newer_than:${rangeDays}d`;
    const seededAt = now.toISOString();
    // Capture the cursor before listing so changes that land during the walk
    // are replayed by the next incremental sync instead of being lost.
    const historyId = await getGmailHistoryId({ accountId });

    const seenPageTokens = new Set<string>();
    let pageToken: string | null = null;
    let pageCount = 0;
    const messagesByExternalId = new Map<string, LifeOpsGmailMessageSummary>();
    do {
      if (pageCount >= GMAIL_SEED_MAX_PAGES) {
        fail(
          409,
          `Gmail returned more than ${GMAIL_SEED_MAX_PAGES} pages for the last ${rangeDays} days; the seed was not completed and no receipt was issued. Choose a shorter range.`,
          "LIFEOPS_GMAIL_SEED_INCOMPLETE",
        );
      }
      const page = await searchGmailMessagesPage({
        accountId,
        query,
        pageToken,
        pageSize: GMAIL_SEED_PAGE_SIZE,
        selfEmail: grant.identityEmail,
      });
      pageCount += 1;
      for (const message of page.messages) {
        const normalized = lifeOpsGmailMessageFromGoogle({
          message,
          grant,
          agentId: this.ctx.agentId(),
          syncedAt: seededAt,
        });
        if (messagesByExternalId.has(normalized.externalId)) {
          fail(
            502,
            "Gmail returned the same message on more than one search page; the seed was aborted before publishing any projection.",
            "LIFEOPS_GMAIL_SEED_DUPLICATE_MESSAGE",
          );
        }
        messagesByExternalId.set(normalized.externalId, normalized);
      }
      pageToken = page.nextPageToken;
      if (pageToken) {
        if (seenPageTokens.has(pageToken)) {
          fail(
            502,
            "Gmail search pagination repeated a page token; the seed was aborted before issuing a receipt.",
            "LIFEOPS_GMAIL_SEED_PAGINATION_REPEATED",
          );
        }
        seenPageTokens.add(pageToken);
      }
    } while (pageToken);

    const messages = [...messagesByExternalId.values()];
    const messageCount = messages.length;
    await this.ctx.repository.publishGmailSeed(
      messages,
      createLifeOpsGmailSyncState({
        agentId: this.ctx.agentId(),
        provider: "google",
        side: grant.side,
        mailbox: GOOGLE_GMAIL_MAILBOX,
        grantId: grant.id,
        maxResults: messageCount,
        historyId,
        cursorStatus: "seeded",
        fullResyncReason: null,
        syncedAt: seededAt,
      }),
    );
    await this.ctx.recordConnectorAudit(
      grant.id,
      "gmail range seeded through plugin-google-workspace",
      { rangeDays, query, connectorAccountId: accountId },
      { messageCount, pageCount, historyCursorPresent: Boolean(historyId) },
    );
    return {
      provider: "google",
      side: grant.side,
      grantId: grant.id,
      connectorAccountId: accountId,
      rangeDays,
      query,
      messageCount,
      pageCount,
      historyCursorPresent: Boolean(historyId),
      seededAt,
    };
  }

  async getGmailSyncHealth(
    requestUrl: URL,
    request: {
      side?: LifeOpsConnectorSide;
      mode?: LifeOpsConnectorMode;
      grantId: string;
    },
  ): Promise<LifeOpsGmailSyncHealth> {
    const grant = await this.deps.requireGoogleGmailGrant(
      requestUrl,
      normalizeOptionalConnectorMode(request.mode, "mode"),
      normalizeOptionalConnectorSide(request.side, "side"),
      request.grantId,
    );
    const state = await this.ctx.repository.getGmailSyncState(
      this.ctx.agentId(),
      "google",
      GOOGLE_GMAIL_MAILBOX,
      grant.side,
      grant.id,
    );
    const cachedMessageCount = await this.ctx.repository.countGmailMessages(
      this.ctx.agentId(),
      "google",
      grant.side,
      grant.id,
    );
    return {
      provider: "google",
      side: grant.side,
      grantId: grant.id,
      connectorAccountId: grant.connectorAccountId ?? accountIdForGrant(grant),
      mailbox: GOOGLE_GMAIL_MAILBOX,
      state:
        state?.fullResyncReason && !state.historyId
          ? "resync_required"
          : state
            ? "current"
            : "never_synced",
      cursorStatus: state?.cursorStatus ?? "never_synced",
      historyCursorPresent: Boolean(state?.historyId),
      fullResyncReason: state?.fullResyncReason ?? null,
      cachedMessageCount,
      syncedAt: state?.syncedAt ?? null,
    };
  }

  async purgeGmailImportedData(
    _requestUrl: URL,
    request: PurgeLifeOpsGmailImportedDataRequest,
    now = new Date(),
  ): Promise<LifeOpsGmailImportedDataPurgeReceipt> {
    if (request.confirmAction !== true) {
      fail(
        409,
        "Removing imported Gmail data requires explicit confirmation immediately before deletion.",
      );
    }
    const side =
      normalizeOptionalConnectorSide(request.side, "side") ?? "owner";
    const grantId = requireNonEmptyString(request.grantId, "grantId");
    const connectorAccountId = requireNonEmptyString(
      request.connectorAccountId,
      "connectorAccountId",
    );
    if (googleAccountIdFromGrantId(grantId) !== connectorAccountId) {
      fail(
        409,
        "The Gmail grant and connector account identities do not match; reconnect before purging imported data.",
      );
    }
    const [deletedMessageCount, deletedSpamReviewCount, syncState] =
      await Promise.all([
        this.ctx.repository.countGmailMessages(
          this.ctx.agentId(),
          "google",
          side,
          grantId,
        ),
        this.ctx.repository.countGmailSpamReviewItems(
          this.ctx.agentId(),
          "google",
          side,
          grantId,
        ),
        this.ctx.repository.getGmailSyncState(
          this.ctx.agentId(),
          "google",
          GOOGLE_GMAIL_MAILBOX,
          side,
          grantId,
        ),
      ]);
    await this.ctx.repository.deleteGmailMessagesForProvider(
      this.ctx.agentId(),
      "google",
      side,
      grantId,
    );
    await this.ctx.repository.deleteGmailSpamReviewItemsForProvider(
      this.ctx.agentId(),
      "google",
      side,
      grantId,
    );
    await this.ctx.repository.deleteGmailSyncState(
      this.ctx.agentId(),
      "google",
      GOOGLE_GMAIL_MAILBOX,
      side,
      grantId,
    );
    return {
      provider: "google",
      side,
      grantId,
      connectorAccountId,
      deletedMessageCount,
      deletedSpamReviewCount,
      deletedSyncCursor: syncState !== null,
      providerMutation: false,
      purgedAt: now.toISOString(),
    };
  }

  async getGmailTriage(
    requestUrl: URL,
    request: GetLifeOpsGmailTriageRequest = {},
    now = new Date(),
  ): Promise<LifeOpsGmailTriageFeed> {
    const mode = normalizeOptionalConnectorMode(request.mode, "mode");
    const side = normalizeOptionalConnectorSide(request.side, "side");
    const limit = explicitMaxResults(request.maxResults);
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
    const limit = explicitMaxResults(request.maxResults);
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
    const grant = await this.deps.requireGoogleGmailGrant(
      requestUrl,
      mode,
      side,
      request.grantId,
    );
    const getMessage = requireGoogleServiceMethod(
      this.ctx.runtime,
      "getMessage",
    );
    let messageId = normalizeOptionalString(request.messageId);
    if (messageId) {
      messageId = externalMessageIdFromInput(messageId);
    }
    let query: string | null = null;
    if (!messageId) {
      query = normalizeGmailSearchQuery(
        request.query ?? "in:inbox newer_than:30d",
      );
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
      agentId: this.ctx.agentId(),
      syncedAt,
    });
    await this.ctx.repository.upsertGmailMessage(message, grant.side);
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
    const messages = triage.messages.filter(
      (message) => message.likelyReplyNeeded,
    );
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
    const items = await this.ctx.repository.listGmailSpamReviewItems(
      this.ctx.agentId(),
      "google",
      {
        status,
        maxResults: explicitMaxResults(request.maxResults),
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
    await this.ctx.repository.updateGmailSpamReviewItemStatus(
      this.ctx.agentId(),
      "google",
      requireNonEmptyString(itemId, "itemId"),
      status,
      status === "pending" ? null : now.toISOString(),
      now.toISOString(),
    );
    const item = await this.ctx.repository.getGmailSpamReviewItem(
      this.ctx.agentId(),
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
      maxResults: explicitMaxResults(request.maxResults),
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
        Math.floor(
          (now.getTime() - Date.parse(message.receivedAt)) / 86_400_000,
        ),
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
    const executionMode = request.executionMode ?? "execute";
    const confirmAction =
      normalizeOptionalBoolean(request.confirmAction, "confirmAction") ?? false;
    const confirmDestructive =
      normalizeOptionalBoolean(
        request.confirmDestructive,
        "confirmDestructive",
      ) ?? false;

    // Non-destructive execute calls (mark_read, archive, labels) keep working
    // without confirmation so existing callers of /api/lifeops/gmail/manage
    // are not broken; destructive operations accept either confirmation flag.
    if (
      executionMode === "execute" &&
      destructive &&
      !confirmAction &&
      !confirmDestructive
    ) {
      fail(
        409,
        `${operation} requires explicit destructive confirmation immediately before execution.`,
      );
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

    const grant = await this.deps.requireGoogleGmailGrant(
      requestUrl,
      mode,
      side,
      grantId,
    );
    if (!grant.capabilities.includes("google.gmail.manage")) {
      fail(
        403,
        "Gmail management access has not been granted. Reconnect Google through @elizaos/plugin-google-workspace with Gmail manage scope.",
      );
    }

    const max = explicitMaxResults(request.maxResults);
    const messages: LifeOpsGmailMessageSummary[] =
      messageIds.length > 0
        ? await Promise.all(
            messageIds.map(async (messageId) => {
              const cached = await this.ctx.repository.getGmailMessage(
                this.ctx.agentId(),
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
                agentId: this.ctx.agentId(),
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
            await this.getGmailSearch(requestUrl, {
              mode,
              side,
              grantId: grant.id,
              // Guaranteed non-empty here: the guard above fails the request
              // when there are no messageIds and no query, and this branch is
              // the no-messageIds path. The `?? ""` only satisfies the type.
              query: query ?? "",
              maxResults: max,
              includeSpamTrash: true,
            })
          ).messages;

    if (messages.length === 0) {
      fail(404, "No Gmail messages matched the requested operation.");
    }

    let status: NonNullable<LifeOpsGmailManageResult["status"]> =
      executionMode === "proposal"
        ? "proposed"
        : executionMode === "dry_run"
          ? "dry_run"
          : "executed";
    let providerReceipt: LifeOpsGmailManageResult["providerReceipt"];
    let affectedMessages = messages;

    if (executionMode === "execute") {
      const modifyGmailMessages = requireGoogleServiceMethod(
        this.ctx.runtime,
        "modifyGmailMessages",
      );
      const receipt = await modifyGmailMessages({
        accountId: accountIdForGrant(grant),
        messageIds: messages.map((message) => message.externalId),
        operation,
        labelIds,
      });
      providerReceipt = {
        requestedMessageIds: receipt.requestedMessageIds,
        succeededMessageIds: receipt.succeededMessageIds,
        failures: receipt.failures,
      };
      const succeeded = new Set(receipt.succeededMessageIds);
      affectedMessages = messages.filter((message) =>
        succeeded.has(message.externalId),
      );
      if (receipt.failures.length > 0) {
        status = affectedMessages.length > 0 ? "partial" : "failed";
      }

      if (operation === "delete") {
        await this.ctx.repository.deleteGmailMessages(
          this.ctx.agentId(),
          "google",
          affectedMessages.map((message) => message.id),
          grant.side,
          grant.id,
        );
      } else {
        for (const message of affectedMessages) {
          const labels = labelsAfterGmailManage(
            message.labels,
            operation,
            labelIds,
          );
          await this.ctx.repository.upsertGmailMessage(
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

    await this.ctx.recordConnectorAudit(
      grant.id,
      "gmail messages managed through plugin-google-workspace",
      {
        operation,
        query,
        messageIds: messages.map((message) => message.id),
        labelIds,
        executionMode,
      },
      {
        affectedCount: affectedMessages.length,
        failedCount: providerReceipt?.failures.length ?? 0,
        destructive,
        connectorAccountId: grant.connectorAccountId ?? null,
      },
    );

    if (executionMode === "execute" && operation === "mark_read") {
      for (const message of affectedMessages) {
        await this.attributeBriefMessageOutcome({
          messageId: gmailBriefSourceId(message.externalId),
          eventType: "opened",
          domainEventId: `gmail_mark_read:${grant.id}:${message.externalId}`,
          weight: 0.25,
        });
      }
    }

    return {
      ok: status !== "failed",
      operation,
      messageIds: messages.map((message) => message.id),
      affectedCount: affectedMessages.length,
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
            processedCount: affectedMessages.length,
            remainingCount: messages.length - affectedMessages.length,
            nextCursor: providerReceipt?.failures[0]?.messageId ?? null,
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
      providerReceipt,
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
      normalizeOptionalBoolean(
        request.includeQuotedOriginal,
        "includeQuotedOriginal",
      ) ?? false;
    const read = await this.readGmailMessage(requestUrl, {
      mode: request.mode,
      side: request.side,
      grantId: request.grantId,
      messageId: request.messageId,
    });
    const draft = draftForMessage(read.message, {
      tone,
      intent,
      includeQuotedOriginal,
    });
    if (request.persistToProvider !== true) {
      return { ...draft, persistence: "local_preview" };
    }
    const grant = await this.deps.requireGoogleGmailGrant(
      requestUrl,
      request.mode,
      request.side,
      request.grantId,
    );
    if (!grant.capabilities.includes("google.gmail.compose")) {
      fail(
        403,
        "Gmail draft access has not been granted. Reconnect Google with Draft Gmail enabled.",
      );
    }
    const createGmailDraft = requireGoogleServiceMethod(
      this.ctx.runtime,
      "createGmailDraft",
    );
    const receipt = await createGmailDraft({
      accountId: accountIdForGrant(grant),
      to: draft.to,
      cc: draft.cc,
      subject: draft.subject,
      bodyText: draft.bodyText,
      threadId: read.message.threadId,
      inReplyTo: gmailHeader(read.message, "Message-Id"),
      references: gmailHeader(read.message, "References"),
    });
    return {
      ...draft,
      providerDraftId: receipt.draftId,
      providerDraftMessageId: receipt.messageId,
      persistence: "gmail_draft",
    };
  }

  async createGmailBatchReplyDrafts(
    requestUrl: URL,
    request: CreateLifeOpsGmailBatchReplyDraftsRequest,
    now = new Date(),
  ): Promise<LifeOpsGmailBatchReplyDraftsFeed> {
    const messages = request.messageIds?.length
      ? await Promise.all(
          request.messageIds.map(
            async (messageId) =>
              (
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
              ).message,
          ),
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
      normalizeOptionalBoolean(
        request.includeQuotedOriginal,
        "includeQuotedOriginal",
      ) ?? false;
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
    const grant = await this.deps.requireGoogleGmailSendGrant(
      requestUrl,
      request.mode,
      request.side,
      request.grantId,
    );
    const sendEmail = requireGoogleServiceMethod(this.ctx.runtime, "sendEmail");
    const sent = await sendEmail(
      googleSendEmailInput({
        accountId: accountIdForGrant(grant),
        to: request.to?.length
          ? request.to
          : read.message.fromEmail
            ? [read.message.fromEmail]
            : [],
        cc: request.cc,
        subject:
          request.subject ??
          `Re: ${read.message.subject.replace(/^Re:\\s*/i, "")}`,
        bodyText: normalizeGmailReplyBody(request.bodyText),
        threadId: read.message.threadId,
      }),
    );
    await this.attributeBriefMessageOutcome({
      messageId: gmailBriefSourceId(read.message.externalId),
      eventType: "replied",
      domainEventId: `gmail_reply:${grant.id}:${sent.id}`,
      weight: 1,
    });
    return { ok: true };
  }

  async sendGmailMessage(
    requestUrl: URL,
    request: SendLifeOpsGmailMessageRequest,
  ): Promise<{ ok: true; messageId: string; threadId: string | null }> {
    const confirmed =
      normalizeOptionalBoolean(request.confirmSend, "confirmSend") ?? false;
    if (!confirmed) {
      fail(409, "Gmail message send requires confirmSend=true.");
    }
    const grant = await this.deps.requireGoogleGmailSendGrant(
      requestUrl,
      request.mode,
      request.side,
      request.grantId,
    );
    const sendEmail = requireGoogleServiceMethod(this.ctx.runtime, "sendEmail");
    const sent = await sendEmail(
      googleSendEmailInput({
        accountId: accountIdForGrant(grant),
        to: request.to,
        cc: request.cc,
        bcc: request.bcc,
        subject: requireNonEmptyString(request.subject, "subject"),
        bodyText: normalizeGmailReplyBody(request.bodyText),
      }),
    );
    return {
      ok: true,
      messageId: sent.id,
      threadId: sent.threadId ?? null,
    };
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
    for (const item of request.items) {
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
    return { ok: true, sentCount: request.items.length };
  }
}
