/**
 * Re-exports the shared awareness contracts for backwards compatibility with
 * `@elizaos/agent` consumers. The shared package owns the canonical contract.
 */
export {
  type AwarenessContributor,
  type AwarenessInvalidationEvent,
  DEFAULT_CACHE_TTL_MS,
  SELF_STATUS_SCHEMA_VERSION,
  SUMMARY_CHAR_LIMIT,
  SUMMARY_TOTAL_CHAR_LIMIT,
} from "@elizaos/shared";
