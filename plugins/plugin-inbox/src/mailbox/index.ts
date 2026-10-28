/**
 * Browser-safe managed Gmail mailbox for phone and browser clients: wire
 * contract, incremental grants, validated Cloud client, durable reviewed
 * operations, read state, attachments, retained edits, reviewed agent
 * hand-off and the mailbox list (paging, bounded caches, saved snapshots and
 * the Home attention summary). No Node built-ins and no React; hosts inject
 * transport and storage.
 */
export * from "./attachments.ts";
export * from "./drafts-controller.ts";
export * from "./failures.ts";
export * from "./grants.ts";
export * from "./links.ts";
export * from "./mail-context.ts";
export * from "./mailbox-list.ts";
export * from "./managed-gmail-client.ts";
export * from "./operation-journal.ts";
export * from "./preview.ts";
export * from "./read-ahead.ts";
export * from "./read-state.ts";
export * from "./retained-draft.ts";
export * from "./review-controller.ts";
export type * from "./types.ts";
