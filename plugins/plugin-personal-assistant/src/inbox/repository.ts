/**
 * Inbox triage repository — re-export shim.
 *
 * The triage repository (raw SQL over `app_lifeops.life_inbox_triage_entries`
 * and `_examples`) moved to `@elizaos/plugin-inbox` as `InboxRepository`. The
 * tables are still registered by PA's schema, but the access layer lives in the
 * inbox plugin. PA callers continue to import `InboxTriageRepository` from here.
 */

export { InboxRepository as InboxTriageRepository } from "@elizaos/plugin-inbox";
