/**
 * RelationshipStore re-export shim.
 *
 * The DB-backed `RelationshipStore` is now a runtime primitive owned by
 * `@elizaos/agent` and surfaced through `KnowledgeGraphService`. This module
 * re-exports it so the rest of LifeOps keeps importing from `./store.js`.
 * New code should resolve the store via the runtime service:
 *
 *   resolveKnowledgeGraphService(runtime)?.getRelationshipStore(agentId)
 */

export { RelationshipStore } from "@elizaos/agent";
