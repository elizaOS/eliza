/**
 * Inbox LLM priority scoring — re-export shim.
 *
 * The scorer (batched TEXT_SMALL scoring with an in-process LRU cache and
 * concurrency cap) moved to `@elizaos/plugin-inbox` alongside the inbox
 * aggregation domain it serves. PA callers continue to import from here; the
 * owner policy for *whether/which model* to score with stays in PA (LifeOps
 * app state) and is injected into the aggregate domain in `service.ts`.
 */

export {
  __resetPriorityScoringCacheForTests,
  type PriorityCategory,
  type PriorityScore,
  type ScoreInboxMessagesOptions,
  scoreInboxMessages,
} from "@elizaos/plugin-inbox/inbox/priority-scoring";
