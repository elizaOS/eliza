/**
 * Inbox aggregation domain — re-export shim.
 *
 * The cross-channel inbox read side (channel normalization, `buildInbox`
 * thread grouping + heuristics, `resolveInboxRequest`, LLM priority
 * orchestration, and the cached read-through `InboxDomain`) moved to
 * `@elizaos/plugin-inbox` (`inbox/aggregate.ts`). PA keeps the host-owned
 * pieces and injects them through the aggregate's typed seams:
 *   - the `life_inbox_messages` cache in `app_lifeops` (`LifeOpsRepository`
 *     satisfies `InboxMessageCache`),
 *   - the Gmail/X connector sources (LifeOps service mixins implement
 *     `GmailInboxSource` / `XDmInboxSource`),
 *   - the priority-scoring owner policy (loaded from the LifeOps app state in
 *     `service.ts`).
 * The `GET /api/lifeops/inbox` transport route also stays in PA
 * (`routes/lifeops-routes.ts`) and calls the composed service's `getInbox`.
 */

export {
  buildInbox,
  buildInboxFromMessages,
  type CachedInboxMessage,
  fetchInbox,
  type InboxChatType,
  type InboxDeps,
  InboxDomain,
  type InboxDomainDeps,
  type InboxMessageCache,
  type LifeOpsInboxService,
  normalizeInboxChannel,
  type PriorityScoringSettings,
  type PriorityScoringSettingsLoader,
  type ResolvedInboxRequest,
  resolveInboxRequest,
  toInboxMessage,
  toInboxMessages,
} from "@elizaos/plugin-inbox/inbox/aggregate";
