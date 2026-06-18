/**
 * EntityStore re-export shim.
 *
 * The DB-backed `EntityStore` is now a runtime primitive owned by
 * `@elizaos/agent` and surfaced through `KnowledgeGraphService`. This module
 * re-exports it so the rest of LifeOps keeps importing from `./store.js`.
 * New code should resolve the store via the runtime service:
 *
 *   resolveKnowledgeGraphService(runtime)?.getEntityStore(agentId)
 */

export { EntityStore } from "@elizaos/agent";
export { AUTO_MERGE_CONFIDENCE_THRESHOLD } from "@elizaos/shared";
