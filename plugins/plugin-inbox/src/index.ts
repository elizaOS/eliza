export { inboxPlugin, default } from "./plugin.ts";

export { inboxAction } from "./actions/inbox.ts";
export { crossChannelContextProvider } from "./providers/cross-channel-context.ts";
export { inboxTriageProvider } from "./providers/inbox-triage.ts";

export {
  type ArchivedInsert,
  type ArchivedRow,
  archivedTable,
  inboxSchema,
  type SnoozedInsert,
  type SnoozedRow,
  snoozedTable,
  type TriageDecisionInsert,
  type TriageDecisionRow,
  triageDecisionsTable,
} from "./db/schema.ts";

export { InboxView } from "./components/inbox/InboxView.tsx";

export * from "./types.ts";
