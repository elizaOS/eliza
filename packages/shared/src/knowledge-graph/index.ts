/**
 * Knowledge-graph primitives (canonical, runtime-level).
 *
 * Pure types + the identity-merge engine for the Entity/Relationship graph.
 * Dependency-free: no DB, no `@elizaos/core`, no plugin imports. The DB-backed
 * `EntityStore` / `RelationshipStore` live in
 * `@elizaos/plugin-personal-assistant`; the wire contracts in
 * `@elizaos/shared/contracts/personal-assistant` re-export these shapes.
 */

export * from "./entity-types.js";
export * from "./merge.js";
export * from "./relationship-types.js";
