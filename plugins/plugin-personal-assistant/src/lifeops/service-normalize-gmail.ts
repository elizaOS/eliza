/**
 * Re-export shim. The Gmail-domain normalization primitives now live in
 * `@elizaos/plugin-inbox` (their natural inbox domain), where they depend only
 * on `node:crypto` and `@elizaos/shared`. This file preserves the historical
 * `./service-normalize-gmail.js` import path for in-plugin callers, importing
 * from the narrow subpath so the inbox React view / plugin definition is not
 * pulled into PA's service layer.
 */

export type { SyncedGoogleGmailMessageSummary } from "@elizaos/plugin-inbox/inbox/gmail-normalize";
export {
  buildFallbackGmailReplyDraftBody,
  buildGmailRecommendations,
  buildGmailReplyDraft,
  buildGmailReplyPreviewLines,
  buildGmailSpamReviewItem,
  collectCalendarEventContactEmails,
  compareGmailMessagePriority,
  createCalendarEventId,
  createGmailMessageId,
  createGmailSpamReviewItemId,
  extractNormalizedEmailAddress,
  extractSubjectTokens,
  filterGmailMessagesBySearch,
  findLinkedMailForCalendarEvent,
  isCalendarSyncStateFresh,
  isGmailSpamReviewCandidate,
  isGmailSyncStateFresh,
  materializeGmailMessageSummary,
  normalizeGeneratedGmailReplyDraftBody,
  normalizeGmailBulkOperation,
  normalizeGmailDraftTone,
  normalizeGmailReplyBody,
  normalizeGmailSearchQuery,
  normalizeGmailSearchQueryMatches,
  normalizeGmailSpamReviewStatus,
  normalizeGmailUnrespondedOlderThanDays,
  normalizeOptionalGmailLabelIdArray,
  normalizeOptionalMessageIdArray,
  normalizeOptionalStringArray,
  parseGmailDateBoundary,
  parseGmailRelativeDuration,
  splitMailboxLikeList,
  summarizeGmailBatchReplyDrafts,
  summarizeGmailNeedsResponse,
  summarizeGmailRecommendations,
  summarizeGmailSearch,
  summarizeGmailSpamReviewItems,
  summarizeGmailTriage,
  summarizeGmailUnresponded,
  wrapUntrustedEmailContent,
} from "@elizaos/plugin-inbox/inbox/gmail-normalize";
