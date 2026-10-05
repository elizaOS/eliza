/** LifeOps gmail contracts. Persisted and wire shapes are preserved. */
import type {
  LifeOpsConnectorMode,
  LifeOpsConnectorSide,
} from "./connectors.js";
import type { LifeOpsActor } from "./policy.js";

export interface LifeOpsGmailEventFilters {
  /** Only fire for these Google connector grant ids. */
  grantIds?: string[];
  /** Only fire when the sender email/display contains one of these substrings. */
  fromIncludesAny?: string[];
  /** Only fire when the subject contains one of these case-insensitive substrings. */
  subjectIncludesAny?: string[];
  /** Only fire when at least one Gmail label id is present. */
  labelIds?: string[];
  /** Only fire when LifeOps classified the message/thread as needing a reply. */
  requiresReplyNeeded?: boolean;
}

export interface LifeOpsGmailMessageSummary {
  id: string;
  externalId: string;
  agentId: string;
  provider: "google";
  side: LifeOpsConnectorSide;
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
  syncedAt: string;
  updatedAt: string;
  /** LifeOps-owned account key for privacy egress; legacy cache rows may omit it until purge/resync. */
  connectorAccountId?: string;
  /** Set when aggregating across multiple Google accounts. */
  grantId?: string;
  /** Set when aggregating across multiple Google accounts. */
  accountEmail?: string;
}

export interface LifeOpsGmailTriageSummary {
  unreadCount: number;
  importantNewCount: number;
  likelyReplyNeededCount: number;
}

export interface LifeOpsGmailTriageFeed {
  messages: LifeOpsGmailMessageSummary[];
  source: "cache" | "synced";
  syncedAt: string | null;
  summary: LifeOpsGmailTriageSummary;
}

export type LifeOpsGmailCursorStatus =
  | "never_synced"
  | "seeded"
  | "incremental"
  | "resynced";

/** Privacy-minimized Gmail cache and History cursor health for one exact grant. */
export interface LifeOpsGmailSyncHealth {
  provider: "google";
  side: LifeOpsConnectorSide;
  grantId: string;
  connectorAccountId: string;
  mailbox: "me";
  state: "disconnected" | "never_synced" | "current" | "resync_required";
  cursorStatus: LifeOpsGmailCursorStatus;
  historyCursorPresent: boolean;
  fullResyncReason: string | null;
  cachedMessageCount: number;
  syncedAt: string | null;
}

export const LIFEOPS_GMAIL_SEED_RANGE_DAYS = [7, 30, 90] as const;

export type LifeOpsGmailSeedRangeDays =
  (typeof LIFEOPS_GMAIL_SEED_RANGE_DAYS)[number];

/**
 * Imports every Gmail message the provider reports for the selected time
 * range into Eliza's local projection. The owner selects a range, not a page
 * budget, so the server walks every provider page; a seed that cannot cover
 * the whole range fails instead of returning a receipt.
 */
export interface SeedLifeOpsGmailRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId: string;
  rangeDays: LifeOpsGmailSeedRangeDays;
}

export interface LifeOpsGmailSeedReceipt {
  provider: "google";
  side: LifeOpsConnectorSide;
  grantId: string;
  connectorAccountId: string;
  rangeDays: LifeOpsGmailSeedRangeDays;
  query: string;
  /** Every message the provider returned for the range; never a page-capped count. */
  messageCount: number;
  pageCount: number;
  historyCursorPresent: boolean;
  seededAt: string;
}

export interface PurgeLifeOpsGmailImportedDataRequest {
  side?: LifeOpsConnectorSide;
  grantId: string;
  connectorAccountId: string;
  /** Purges only Eliza's local projection; it never changes the provider mailbox. */
  confirmAction: boolean;
}

export interface LifeOpsGmailImportedDataPurgeReceipt {
  provider: "google";
  side: LifeOpsConnectorSide;
  grantId: string;
  connectorAccountId: string;
  deletedMessageCount: number;
  deletedSpamReviewCount: number;
  deletedSyncCursor: boolean;
  providerMutation: false;
  purgedAt: string;
}

export interface LifeOpsGmailNeedsResponseSummary {
  totalCount: number;
  unreadCount: number;
  importantCount: number;
}

export interface LifeOpsGmailNeedsResponseFeed {
  messages: LifeOpsGmailMessageSummary[];
  source: "cache" | "synced";
  syncedAt: string | null;
  summary: LifeOpsGmailNeedsResponseSummary;
}

export interface GetLifeOpsGmailTriageRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  /** Target a specific Google account by grant ID (multi-account). */
  grantId?: string;
  forceSync?: boolean;
  maxResults?: number;
}

export interface GetLifeOpsGmailSearchRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  forceSync?: boolean;
  maxResults?: number;
  query: string;
  replyNeededOnly?: boolean;
  includeSpamTrash?: boolean;
  grantId?: string;
}

export interface LifeOpsGmailSearchSummary {
  totalCount: number;
  unreadCount: number;
  importantCount: number;
  replyNeededCount: number;
}

export interface LifeOpsGmailSearchFeed {
  query: string;
  messages: LifeOpsGmailMessageSummary[];
  source: "cache" | "synced";
  syncedAt: string | null;
  summary: LifeOpsGmailSearchSummary;
}

export const LIFEOPS_GMAIL_RECOMMENDATION_KINDS = [
  "reply",
  "archive",
  "mark_read",
  "review_spam",
] as const;

export type LifeOpsGmailRecommendationKind =
  (typeof LIFEOPS_GMAIL_RECOMMENDATION_KINDS)[number];

export const LIFEOPS_GMAIL_BULK_OPERATIONS = [
  "archive",
  "trash",
  "delete",
  "report_spam",
  "mark_read",
  "mark_unread",
  "apply_label",
  "remove_label",
] as const;

export type LifeOpsGmailBulkOperation =
  (typeof LIFEOPS_GMAIL_BULK_OPERATIONS)[number];

export const LIFEOPS_GMAIL_MANAGE_EXECUTION_MODES = [
  "proposal",
  "dry_run",
  "execute",
] as const;

export type LifeOpsGmailManageExecutionMode =
  (typeof LIFEOPS_GMAIL_MANAGE_EXECUTION_MODES)[number];

export const LIFEOPS_GMAIL_MANAGE_STATUSES = [
  "proposed",
  "dry_run",
  "approved",
  "executed",
  "partial",
  "failed",
  "cancelled",
] as const;

export type LifeOpsGmailManageStatus =
  (typeof LIFEOPS_GMAIL_MANAGE_STATUSES)[number];

export const LIFEOPS_GMAIL_MANAGE_UNDO_STATUSES = [
  "not_available",
  "available",
  "completed",
  "expired",
  "failed",
] as const;

export type LifeOpsGmailManageUndoStatus =
  (typeof LIFEOPS_GMAIL_MANAGE_UNDO_STATUSES)[number];

export interface LifeOpsGmailManageApprovalIdentity {
  proposalId?: string;
  approvalId?: string;
  proposedBy?: LifeOpsActor;
  approvedBy?: LifeOpsActor;
  approvedAt?: string;
}

export interface LifeOpsGmailManagePlanIdentity {
  planId?: string;
  planHash?: string;
  idempotencyKey?: string;
}

export interface LifeOpsGmailManageMessageSnapshot {
  messageId: string;
  externalId: string;
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  receivedAt: string;
  snippet: string;
  labels: string[];
  grantId?: string;
  accountEmail?: string;
  syncedAt?: string;
  snapshotHash?: string;
}

export interface LifeOpsGmailManageChunkRequest {
  chunkId: string;
  chunkIndex: number;
  chunkCount: number;
  messageIds?: string[];
  cursor?: string;
}

export interface LifeOpsGmailManageChunkStatus {
  chunkId: string;
  chunkIndex: number;
  chunkCount: number;
  processedCount: number;
  remainingCount: number;
  nextCursor: string | null;
}

export interface LifeOpsGmailManageAuditContext {
  auditEventId?: string;
  auditRef?: string;
  parentAuditEventId?: string;
  actor?: LifeOpsActor;
}

export interface LifeOpsGmailManageAuditState {
  auditEventId: string | null;
  auditRef: string | null;
  actor: LifeOpsActor;
  recordedAt: string | null;
}

export interface LifeOpsGmailManageUndoRequest {
  undoId: string;
  auditEventId?: string;
  reason?: string;
}

export interface LifeOpsGmailManageUndoState {
  status: LifeOpsGmailManageUndoStatus;
  undoId: string | null;
  undoExpiresAt: string | null;
  auditEventId: string | null;
  messageIds: string[];
}

export interface ManageLifeOpsGmailMessagesRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  operation: LifeOpsGmailBulkOperation;
  messageIds?: string[];
  query?: string;
  maxResults?: number;
  labelIds?: string[];
  /**
   * Approval captured immediately before any provider-side mailbox mutation,
   * including archive, read state, labels, trash, delete, and spam.
   */
  confirmAction?: boolean;
  /** Legacy destructive confirmation; either flag satisfies the destructive gate. */
  confirmDestructive?: boolean;
  executionMode?: LifeOpsGmailManageExecutionMode;
  reason?: string;
  approval?: LifeOpsGmailManageApprovalIdentity;
  plan?: LifeOpsGmailManagePlanIdentity;
  selectedMessageSnapshots?: LifeOpsGmailManageMessageSnapshot[];
  chunk?: LifeOpsGmailManageChunkRequest;
  audit?: LifeOpsGmailManageAuditContext;
  undo?: LifeOpsGmailManageUndoRequest;
}

export interface LifeOpsGmailManageResult {
  /**
   * `false` only when `status` is `failed` (the provider rejected every
   * requested message); `partial` receipts keep `ok: true` and list the
   * failures in `providerReceipt`.
   */
  ok: boolean;
  operation: LifeOpsGmailBulkOperation;
  messageIds: string[];
  affectedCount: number;
  labelIds: string[];
  destructive: boolean;
  grantId?: string;
  accountEmail?: string;
  executionMode?: LifeOpsGmailManageExecutionMode;
  status?: LifeOpsGmailManageStatus;
  reason?: string;
  approval?: LifeOpsGmailManageApprovalIdentity;
  plan?: LifeOpsGmailManagePlanIdentity;
  selectedMessageSnapshots?: LifeOpsGmailManageMessageSnapshot[];
  chunk?: LifeOpsGmailManageChunkStatus;
  audit?: LifeOpsGmailManageAuditState;
  undo?: LifeOpsGmailManageUndoState;
  providerReceipt?: {
    requestedMessageIds: string[];
    succeededMessageIds: string[];
    failures: Array<{
      messageId: string;
      code: number | null;
      retryable: boolean;
    }>;
  };
}

export interface LifeOpsGmailRecommendationMessage {
  messageId: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  receivedAt: string;
  snippet: string;
  labels: string[];
}

export interface LifeOpsGmailRecommendation {
  id: string;
  kind: LifeOpsGmailRecommendationKind;
  title: string;
  rationale: string;
  operation: LifeOpsGmailBulkOperation | null;
  messageIds: string[];
  query: string | null;
  labelIds: string[];
  affectedCount: number;
  destructive: boolean;
  requiresConfirmation: boolean;
  confidence: number;
  sampleMessages: LifeOpsGmailRecommendationMessage[];
}

export interface LifeOpsGmailRecommendationsSummary {
  totalCount: number;
  replyCount: number;
  archiveCount: number;
  markReadCount: number;
  spamReviewCount: number;
  destructiveCount: number;
}

export interface LifeOpsGmailRecommendationsFeed {
  recommendations: LifeOpsGmailRecommendation[];
  source: "cache" | "synced";
  syncedAt: string | null;
  summary: LifeOpsGmailRecommendationsSummary;
}

export interface GetLifeOpsGmailRecommendationsRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  forceSync?: boolean;
  maxResults?: number;
  query?: string;
  replyNeededOnly?: boolean;
  includeSpamTrash?: boolean;
}

export const LIFEOPS_GMAIL_SPAM_REVIEW_STATUSES = [
  "pending",
  "confirmed_spam",
  "not_spam",
  "dismissed",
] as const;

export type LifeOpsGmailSpamReviewStatus =
  (typeof LIFEOPS_GMAIL_SPAM_REVIEW_STATUSES)[number];

export interface LifeOpsGmailSpamReviewItem {
  id: string;
  agentId: string;
  provider: "google";
  side: LifeOpsConnectorSide;
  grantId: string;
  accountEmail: string | null;
  messageId: string;
  externalMessageId: string;
  threadId: string;
  subject: string;
  from: string;
  fromEmail: string | null;
  receivedAt: string;
  snippet: string;
  labels: string[];
  rationale: string;
  confidence: number;
  status: LifeOpsGmailSpamReviewStatus;
  createdAt: string;
  updatedAt: string;
  reviewedAt: string | null;
}

export interface LifeOpsGmailSpamReviewSummary {
  totalCount: number;
  pendingCount: number;
  confirmedSpamCount: number;
  notSpamCount: number;
  dismissedCount: number;
}

export interface LifeOpsGmailSpamReviewFeed {
  items: LifeOpsGmailSpamReviewItem[];
  summary: LifeOpsGmailSpamReviewSummary;
}

export interface GetLifeOpsGmailSpamReviewRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  status?: LifeOpsGmailSpamReviewStatus;
  maxResults?: number;
}

export interface UpdateLifeOpsGmailSpamReviewItemRequest {
  status: LifeOpsGmailSpamReviewStatus;
}

export interface LifeOpsGmailUnrespondedThread {
  threadId: string;
  messageId: string;
  subject: string;
  to: string[];
  cc: string[];
  lastOutboundAt: string;
  lastInboundAt: string | null;
  daysWaiting: number;
  snippet: string;
  labels: string[];
  htmlLink: string | null;
  grantId?: string;
  accountEmail?: string;
}

export interface LifeOpsGmailUnrespondedSummary {
  totalCount: number;
  oldestDaysWaiting: number | null;
}

export interface LifeOpsGmailUnrespondedFeed {
  threads: LifeOpsGmailUnrespondedThread[];
  source: "synced";
  syncedAt: string;
  summary: LifeOpsGmailUnrespondedSummary;
}

export interface GetLifeOpsGmailUnrespondedRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  olderThanDays?: number;
  maxResults?: number;
}

export interface IngestLifeOpsGmailEventRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  messageId: string;
  eventKind?: "gmail.message.received" | "gmail.thread.needs_response";
  occurredAt?: string;
  maxWorkflowRuns?: number;
}

export interface LifeOpsGmailEventIngestResult {
  ok: true;
  event: {
    id: string;
    kind: "gmail.message.received" | "gmail.thread.needs_response";
    occurredAt: string;
    payload: Record<string, unknown>;
  };
  workflowRunIds: string[];
}

export const LIFEOPS_GMAIL_DRAFT_TONES = ["brief", "neutral", "warm"] as const;

export type LifeOpsGmailDraftTone = (typeof LIFEOPS_GMAIL_DRAFT_TONES)[number];

export interface CreateLifeOpsGmailReplyDraftRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  messageId: string;
  grantId?: string;
  tone?: LifeOpsGmailDraftTone;
  intent?: string;
  includeQuotedOriginal?: boolean;
  /** Persist the reviewed draft in Gmail without sending it. */
  persistToProvider?: boolean;
  conversationContext?: string[];
  actionHistory?: string[];
  trajectorySummary?: string | null;
}

export interface LifeOpsGmailReplyDraft {
  messageId: string;
  threadId: string;
  subject: string;
  to: string[];
  cc: string[];
  bodyText: string;
  previewLines: string[];
  sendAllowed: boolean;
  requiresConfirmation: boolean;
  providerDraftId?: string;
  providerDraftMessageId?: string | null;
  persistence?: "local_preview" | "gmail_draft";
}

export interface CreateLifeOpsGmailBatchReplyDraftsRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  forceSync?: boolean;
  maxResults?: number;
  query?: string;
  messageIds?: string[];
  tone?: LifeOpsGmailDraftTone;
  intent?: string;
  includeQuotedOriginal?: boolean;
  replyNeededOnly?: boolean;
  conversationContext?: string[];
  actionHistory?: string[];
  trajectorySummary?: string | null;
}

export interface LifeOpsGmailBatchReplyDraftsSummary {
  totalCount: number;
  sendAllowedCount: number;
  requiresConfirmationCount: number;
}

export interface LifeOpsGmailBatchReplyDraftsFeed {
  query: string | null;
  messages: LifeOpsGmailMessageSummary[];
  drafts: LifeOpsGmailReplyDraft[];
  source: "cache" | "synced";
  syncedAt: string | null;
  summary: LifeOpsGmailBatchReplyDraftsSummary;
}

export interface SendLifeOpsGmailReplyRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  messageId: string;
  bodyText: string;
  subject?: string;
  to?: string[];
  cc?: string[];
  confirmSend?: boolean;
}

export interface SendLifeOpsGmailMessageRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  confirmSend?: boolean;
}

export interface LifeOpsGmailBatchReplySendItem {
  messageId: string;
  bodyText: string;
  subject?: string;
  to?: string[];
  cc?: string[];
}

export interface SendLifeOpsGmailBatchReplyRequest {
  side?: LifeOpsConnectorSide;
  mode?: LifeOpsConnectorMode;
  grantId?: string;
  confirmSend?: boolean;
  items: LifeOpsGmailBatchReplySendItem[];
}

export interface LifeOpsGmailBatchReplySendResult {
  ok: true;
  sentCount: number;
}
