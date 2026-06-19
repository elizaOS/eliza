/**
 * Re-export shim. The Gmail-domain normalization primitives now live in
 * `@elizaos/plugin-inbox` (their natural inbox domain), where they depend only
 * on `node:crypto` and `@elizaos/shared`. This file preserves the historical
 * `./service-normalize-gmail.js` import path for in-plugin callers, importing
 * from the narrow subpath so the inbox React view / plugin definition is not
 * pulled into PA's service layer.
 */
export {
  normalizeGmailSearchQuery,
  normalizeGmailBulkOperation,
  normalizeGmailUnrespondedOlderThanDays,
  parseGmailRelativeDuration,
  parseGmailDateBoundary,
  splitMailboxLikeList,
  extractNormalizedEmailAddress,
  normalizeOptionalMessageIdArray,
  normalizeOptionalGmailLabelIdArray,
  normalizeGmailSearchQueryMatches,
  filterGmailMessagesBySearch,
  compareGmailMessagePriority,
  normalizeGmailDraftTone,
  normalizeOptionalStringArray,
  normalizeGmailReplyBody,
  summarizeGmailSearch,
  summarizeGmailBatchReplyDrafts,
  collectCalendarEventContactEmails,
  extractSubjectTokens,
  findLinkedMailForCalendarEvent,
  isGmailSyncStateFresh,
  summarizeGmailTriage,
  summarizeGmailNeedsResponse,
  summarizeGmailUnresponded,
  isGmailSpamReviewCandidate,
  buildGmailSpamReviewItem,
  normalizeGmailSpamReviewStatus,
  summarizeGmailSpamReviewItems,
  buildGmailRecommendations,
  summarizeGmailRecommendations,
  wrapUntrustedEmailContent,
  buildFallbackGmailReplyDraftBody,
  normalizeGeneratedGmailReplyDraftBody,
  buildGmailReplyPreviewLines,
  buildGmailReplyDraft,
  createCalendarEventId,
  createGmailMessageId,
  createGmailSpamReviewItemId,
  materializeGmailMessageSummary,
  isCalendarSyncStateFresh,
} from "@elizaos/plugin-inbox/inbox/gmail-normalize";
export type { SyncedGoogleGmailMessageSummary } from "@elizaos/plugin-inbox/inbox/gmail-normalize";
