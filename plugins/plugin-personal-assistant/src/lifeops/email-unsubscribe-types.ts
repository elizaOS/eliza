/**
 * Email-unsubscribe types moved to `@elizaos/plugin-inbox` (their natural inbox
 * domain) as part of the gmail-curation connector re-architecture. PA callers
 * continue to import them from here via this thin re-export shim.
 */
export type {
  EmailSubscriptionScanResult,
  EmailSubscriptionScanSummary,
  EmailSubscriptionSender,
  EmailUnsubscribeMethod,
  EmailUnsubscribeRecord,
  EmailUnsubscribeRequest,
  EmailUnsubscribeResult,
  EmailUnsubscribeScanRequest,
  EmailUnsubscribeStatus,
} from "@elizaos/plugin-inbox/inbox/email-unsubscribe-types";
