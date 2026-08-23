/**
 * Gmail service mixin: declares the `LifeOpsGmailService` interface and the
 * `withGmail` mixin that composes the Gmail domain's inbox-triage, search,
 * reply-draft, and send methods onto the LifeOpsService base.
 */
import type {
  CreateLifeOpsGmailBatchReplyDraftsRequest,
  CreateLifeOpsGmailReplyDraftRequest,
  GetLifeOpsGmailRecommendationsRequest,
  GetLifeOpsGmailSearchRequest,
  GetLifeOpsGmailSpamReviewRequest,
  GetLifeOpsGmailTriageRequest,
  GetLifeOpsGmailUnrespondedRequest,
  IngestLifeOpsGmailEventRequest,
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
} from "../contracts/index.js";

export interface LifeOpsGmailService {
  seedGmailMessages(
    requestUrl: URL,
    request: SeedLifeOpsGmailRequest,
    now?: Date,
  ): Promise<LifeOpsGmailSeedReceipt>;
  getGmailSyncHealth(
    requestUrl: URL,
    request: {
      side?: LifeOpsConnectorSide;
      mode?: LifeOpsConnectorMode;
      grantId: string;
    },
  ): Promise<LifeOpsGmailSyncHealth>;
  purgeGmailImportedData(
    requestUrl: URL,
    request: PurgeLifeOpsGmailImportedDataRequest,
    now?: Date,
  ): Promise<LifeOpsGmailImportedDataPurgeReceipt>;
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
  ): Promise<{ ok: true; messageId: string; threadId: string | null }>;
  sendGmailReplies(
    requestUrl: URL,
    request: SendLifeOpsGmailBatchReplyRequest,
  ): Promise<LifeOpsGmailBatchReplySendResult>;
}
