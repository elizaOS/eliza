/**
 * Knowledge-graph primitives (canonical, runtime-level).
 *
 * Pure types + the identity-merge engine for the Entity/Relationship graph.
 * Dependency-free: no DB, no `@elizaos/core`, no plugin imports. The DB-backed
 * `EntityStore` / `RelationshipStore` live in
 * `@elizaos/plugin-relationships/knowledge-graph`; the wire contracts in
 * `@elizaos/core/contracts/personal-assistant` re-export these shapes.
 */
export * from "@elizaos/core/knowledge-graph/entity-types";
export * from "@elizaos/core/knowledge-graph/merge";
export * from "@elizaos/core/knowledge-graph/relationship-types";
