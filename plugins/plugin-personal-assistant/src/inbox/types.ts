/**
 * Inbox triage types — re-export shim.
 *
 * The triage-domain types (InboundMessage, TriageEntry, TriageClassification,
 * TriageUrgency, OwnerAction, TriageExample, TriageResult, DeferredInboxDraft,
 * and the shared InboxTriage* config re-exports) moved to
 * `@elizaos/plugin-inbox`. PA callers continue to import them from here.
 */

export * from "@elizaos/plugin-inbox/inbox/types";
