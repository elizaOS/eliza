/**
 * Inbox triage repository — re-export shim.
 *
 * The triage repository (raw SQL over `app_inbox.life_inbox_triage_entries`
 * and `_examples`) moved to `@elizaos/plugin-inbox` as `InboxRepository`, which
 * now owns those tables in its own `app_inbox` schema (PA keeps the app_lifeops
 * defs only as the dormant migration source). PA callers continue to import
 * `InboxTriageRepository` from here.
 */

export { InboxRepository as InboxTriageRepository } from "@elizaos/plugin-inbox/inbox/repository";
