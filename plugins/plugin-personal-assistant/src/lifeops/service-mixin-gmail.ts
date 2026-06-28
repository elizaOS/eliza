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
import { GmailDomain } from "./domains/gmail-service.js";
import type {
  Constructor,
  LifeOpsServiceBase,
  MixinClass,
} from "./service-mixin-core.js";

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

/**
 * `requireGoogleGmailGrant` / `requireGoogleGmailSendGrant` are contributed by
 * the Google mixin (`withGoogle`); the localized cast wires them into the Gmail
 * sub-service from the composed instance.
 */
type GoogleGmailGrantProvider = {
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

/** @internal */
export function withGmail<TBase extends Constructor<LifeOpsServiceBase>>(
  Base: TBase,
): MixinClass<TBase, LifeOpsGmailService> {
  class LifeOpsGmailServiceMixin extends Base {
    // `this` (a LifeOpsServiceBase subclass) satisfies LifeOpsContext.
    // Public (not private) to avoid TS4094 on the re-exported mixin class.
    readonly gmailDomain = new GmailDomain(this, {
      requireGoogleGmailGrant: (
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      ) =>
        (this as unknown as GoogleGmailGrantProvider).requireGoogleGmailGrant(
          requestUrl,
          requestedMode,
          requestedSide,
          grantId,
        ),
      requireGoogleGmailSendGrant: (
        requestUrl,
        requestedMode,
        requestedSide,
        grantId,
      ) =>
        (
          this as unknown as GoogleGmailGrantProvider
        ).requireGoogleGmailSendGrant(
          requestUrl,
          requestedMode,
          requestedSide,
          grantId,
        ),
    });

    getGmailTriage(
      requestUrl: URL,
      request?: GetLifeOpsGmailTriageRequest,
      now?: Date,
    ): Promise<LifeOpsGmailTriageFeed> {
      return this.gmailDomain.getGmailTriage(requestUrl, request, now);
    }

    getGmailSearch(
      requestUrl: URL,
      request: GetLifeOpsGmailSearchRequest,
      now?: Date,
    ): Promise<LifeOpsGmailSearchFeed> {
      return this.gmailDomain.getGmailSearch(requestUrl, request, now);
    }

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
    }> {
      return this.gmailDomain.readGmailMessage(requestUrl, request, now);
    }

    getGmailNeedsResponse(
      requestUrl: URL,
      request?: GetLifeOpsGmailTriageRequest,
      now?: Date,
    ): Promise<LifeOpsGmailNeedsResponseFeed> {
      return this.gmailDomain.getGmailNeedsResponse(requestUrl, request, now);
    }

    getGmailRecommendations(
      requestUrl: URL,
      request?: GetLifeOpsGmailRecommendationsRequest,
      now?: Date,
    ): Promise<LifeOpsGmailRecommendationsFeed> {
      return this.gmailDomain.getGmailRecommendations(requestUrl, request, now);
    }

    getGmailSpamReviewItems(
      requestUrl: URL,
      request?: GetLifeOpsGmailSpamReviewRequest,
    ): Promise<LifeOpsGmailSpamReviewFeed> {
      return this.gmailDomain.getGmailSpamReviewItems(requestUrl, request);
    }

    updateGmailSpamReviewItem(
      requestUrl: URL,
      itemId: string,
      request: UpdateLifeOpsGmailSpamReviewItemRequest,
      now?: Date,
    ): Promise<{ item: LifeOpsGmailSpamReviewItem }> {
      return this.gmailDomain.updateGmailSpamReviewItem(
        requestUrl,
        itemId,
        request,
        now,
      );
    }

    getGmailUnresponded(
      requestUrl: URL,
      request?: GetLifeOpsGmailUnrespondedRequest,
      now?: Date,
    ): Promise<LifeOpsGmailUnrespondedFeed> {
      return this.gmailDomain.getGmailUnresponded(requestUrl, request, now);
    }

    manageGmailMessages(
      requestUrl: URL,
      request: ManageLifeOpsGmailMessagesRequest,
    ): Promise<LifeOpsGmailManageResult> {
      return this.gmailDomain.manageGmailMessages(requestUrl, request);
    }

    ingestGmailEvent(
      requestUrl: URL,
      request: IngestLifeOpsGmailEventRequest,
      now?: Date,
    ): Promise<LifeOpsGmailEventIngestResult> {
      return this.gmailDomain.ingestGmailEvent(requestUrl, request, now);
    }

    createGmailBatchReplyDrafts(
      requestUrl: URL,
      request: CreateLifeOpsGmailBatchReplyDraftsRequest,
      now?: Date,
    ): Promise<LifeOpsGmailBatchReplyDraftsFeed> {
      return this.gmailDomain.createGmailBatchReplyDrafts(
        requestUrl,
        request,
        now,
      );
    }

    createGmailReplyDraft(
      requestUrl: URL,
      request: CreateLifeOpsGmailReplyDraftRequest,
    ): Promise<LifeOpsGmailReplyDraft> {
      return this.gmailDomain.createGmailReplyDraft(requestUrl, request);
    }

    sendGmailReply(
      requestUrl: URL,
      request: SendLifeOpsGmailReplyRequest,
    ): Promise<{ ok: true }> {
      return this.gmailDomain.sendGmailReply(requestUrl, request);
    }

    sendGmailMessage(
      requestUrl: URL,
      request: SendLifeOpsGmailMessageRequest,
    ): Promise<{ ok: true }> {
      return this.gmailDomain.sendGmailMessage(requestUrl, request);
    }

    sendGmailReplies(
      requestUrl: URL,
      request: SendLifeOpsGmailBatchReplyRequest,
    ): Promise<LifeOpsGmailBatchReplySendResult> {
      return this.gmailDomain.sendGmailReplies(requestUrl, request);
    }
  }

  return LifeOpsGmailServiceMixin as unknown as MixinClass<
    TBase,
    LifeOpsGmailService
  >;
}
