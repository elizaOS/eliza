export {
  __resetInboxFetchersForTests,
  type InboxFetcher,
  type InboxFetchers,
  type InboxPlatform,
  inboxAction,
  setInboxFetchers,
} from "./actions/inbox.ts";
export { InboxView } from "./components/inbox/InboxView.tsx";
// Email-curation decision engine. Pure (email + context → save/archive/delete/
// review with evidence and citations); takes injected identity/policy hooks.
// Also consumable via the narrow subpath
// `@elizaos/plugin-inbox/inbox/email-curation`.
export * from "./inbox/email-curation.ts";
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
} from "./inbox/email-unsubscribe-types.ts";
// Gmail-domain normalization primitives. Pure; consumable via the narrow
// subpath `@elizaos/plugin-inbox/inbox/gmail-normalize` (avoids pulling the
// React view / plugin definition into service-layer callers).
export * from "./inbox/gmail-normalize.ts";
export {
  createInboxGmailGateway,
  type InboxGmailGateway,
} from "./inbox/google-gmail-seam.ts";
export { InboxRepository } from "./inbox/repository.ts";
export {
  InboxService,
  type SearchOptions,
  type TriagedMessage,
  type TriageOptions,
  type TriageRunResult,
} from "./inbox/service.ts";
export type {
  InboundMessage,
  OwnerAction,
  TriageClassification,
  TriageEntry,
  TriageExample,
  TriageResult,
  TriageUrgency,
} from "./inbox/types.ts";
export { InboxUnsubscribeRepository } from "./inbox/unsubscribe-repository.ts";
export {
  InboxUnsubscribeService,
  type InboxUnsubscribeServiceDeps,
} from "./inbox/unsubscribe-service.ts";
export { default, inboxPlugin } from "./plugin.ts";
export { inboxTriageProvider } from "./providers/inbox-triage.ts";

export * from "./types.ts";
